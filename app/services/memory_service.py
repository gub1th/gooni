"""Local SQL-backed memory store. Replaces the Mem0 hosted service.

Pipeline per chat exchange:
  1. extract_candidates  (LLM)  — pull typed memory dicts from the turn
  2. for each candidate:
       cosine-search similar active memories of the same type
       reconcile_candidate (LLM) — decide ADD / UPDATE / DELETE / NONE
       apply the decision (insert / supersede / mark inactive / boost)

Retrieval injects always-included preferences plus the top-5 facts/episodes
by cosine similarity to the user's query — same shape as the old prompt
context.
"""

import json
from datetime import datetime

from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from ..db.database import SessionLocal
from ..db.models import Memory
from ..llm.client import llm_client
from .memory_extraction import extract_candidates, reconcile_candidate
from .note_service import _cosine_similarity


# Below this length, an exchange is too short to carry a memorable signal
# ("ok", "got it"). Skips the extraction LLM call entirely.
MIN_EXCHANGE_LEN = 30

# Cosine cutoff for "similar enough to be a candidate for reconcile". Lower
# than the dedup threshold (0.85) used previously, since reconcile needs to
# *consider* contradictions, not just exact dupes.
RECONCILE_SIMILARITY_FLOOR = 0.70

# Preferences are paraphrased a lot ("avoid being too directive" vs "less
# directive" vs "be concise"). Dropping the floor lets near-paraphrases
# surface as reconcile candidates so the LLM can collapse them into NONE
# / UPDATE instead of writing a duplicate row. Other types keep the
# stricter floor — they're declarative enough that surface similarity
# tracks semantic similarity well.
RECONCILE_PREFERENCE_FLOOR = 0.55

# Number of similar existing memories pulled per candidate during reconcile.
RECONCILE_TOP_K = 3
# Preferences also get more candidate headroom — with N prefs in the DB,
# top-3 can miss the actual paraphrase if unrelated-but-lexically-similar
# rows rank higher.
RECONCILE_PREFERENCE_TOP_K = 6

# Default top-K for cosine search callers that don't pass one (e.g. /search).
# Per-type retrieval used by build_memory_context_with_debug lives in
# RETRIEVAL_PER_TYPE below — this constant no longer governs the master prompt.
RETRIEVAL_TOP_K = 5

# Per-type retrieval config for the master prompt. Categories used to share
# one cosine bucket (top-5, floor 0.30) which wasted the type signal — a recall
# query and a planning query got identical pulls, and weak-cosine rows from
# one type displaced stronger rows from another by accident.
#
# Empirical row counts (2026-05-06): fact 110, episode 143, preference 17,
# routine 1, goal 0, constraint 0. Several types sit at 0 today because the
# extractor doesn't surface them in practice — but they're kept here so that
# *if* extraction starts producing them (after prompt nudges or model bumps),
# retrieval picks them up automatically without another refactor. Empty
# buckets cost one near-instant cosine no-op per turn.
#
# Type-by-type:
# - 'fact': dense, short content, paraphrased less → lower floor
# - 'episode': verbose, over-pulls on weak overlap → stricter floor
# - 'routine' / 'constraint' / 'goal': underpopulated today; modest K + floor.
#   'goal' overlaps semantically with focuses (list_items injected via
#   item_service.get_active_context) but kept here for unrealized aspirations
#   that haven't graduated to a focus row. See #213 (type deprecation pending
#   Model D decision) and #215 (constraint extraction never fires).
RETRIEVAL_PER_TYPE: dict[str, dict[str, float | int]] = {
    "fact":       {"top_k": 3, "floor": 0.25},
    "routine":    {"top_k": 2, "floor": 0.30},
    "constraint": {"top_k": 2, "floor": 0.30},
    "goal":       {"top_k": 2, "floor": 0.30},
    "episode":    {"top_k": 3, "floor": 0.35},
}

# Cap on feedback-derived preferences (key prefixed with `feedback__`) that
# get always-injected. Without this, every tone correction Daniel ever wrote
# accumulates and bloats the system prompt — saw a turn pulling 50+ active
# preferences. Manually-curated prefs (no feedback prefix) bypass the cap so
# explicit user choices stay sticky. Most-recent-N is the simplest "still
# relevant" heuristic until we have richer signals (usage count, last-used).
FEEDBACK_PREF_CAP = 8

# Max content length for an extracted candidate before we drop it as garbage.
MAX_CANDIDATE_LEN = 600

# Prefix on the `key` column used for feedback-derived preferences. Lets the
# undo command find feedback memories without touching user-curated ones.
_FEEDBACK_KEY_PREFIX = "feedback__"

# Stopwords stripped during the deterministic dedup normalize. Tiny set —
# only the words that genuinely add no semantic signal in profile content
# ("user prefers X" vs "X" should dedupe). Bigger lists risk collapsing
# meaningfully different rules together.
_DEDUP_STOPWORDS = {
    "a", "an", "the", "is", "to", "be", "of",
    "user", "daniel", "i", "my", "me",
    "prefers", "prefer", "wants", "want", "likes", "like", "enjoys",
}


def _normalize_for_dedup(text: str) -> str:
    """Lowercase, strip punctuation, drop stopwords, collapse whitespace.
    Returns "" for empty/garbage input. Used as a deterministic pre-LLM
    dedup key — two memories whose normalized form is identical are treated
    as duplicates. Cheap (~10µs) so we run it on every reconcile."""
    if not text:
        return ""
    import re as _re
    t = text.lower()
    t = _re.sub(r"[^a-z0-9\s]", " ", t)
    tokens = [w for w in t.split() if w and w not in _DEDUP_STOPWORDS]
    return " ".join(tokens)


def _slug_rule(rule: str) -> str:
    """Stable snake_case key for a feedback rule, prefixed for filtering."""
    import re as _re
    slug = _re.sub(r"[^a-z0-9]+", "_", rule.lower()).strip("_")[:60]
    if not slug:
        slug = "rule"
    return f"{_FEEDBACK_KEY_PREFIX}{slug}"


def _serialize(m: Memory) -> dict:
    """For routes/MCP that historically consumed Mem0's dict shape."""
    return {
        "id": m.id,
        "memory": m.content,  # legacy key from Mem0 callers
        "type": m.type,
        "key": m.key,
        "content": m.content,
        "confidence": m.confidence,
        "is_active": bool(m.is_active),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


class MemoryService:
    def __init__(self):
        # Cached process-lifetime flag for has_memories(). Reset on writes.
        self._has_memories_cache: bool | None = None

    # ── helpers ─────────────────────────────────────────────────────────────

    def _scoped(self, db: Session | None):
        """Use caller's session when given; else open a fresh one. Returns
        (session, owns_it_flag). Caller closes if owns_it_flag is True.
        """
        if db is not None:
            return db, False
        return SessionLocal(), True

    def _embed(self, text: str) -> list[float] | None:
        if not text or not text.strip():
            return None
        emb, _ = llm_client.generate_embedding(text)
        return emb or None

    def _cosine_search(
        self,
        db: Session,
        query_vec: list[float],
        type_filter: list[str] | None = None,
        limit: int = RETRIEVAL_TOP_K,
        floor: float = 0.0,
    ) -> list[tuple[Memory, float]]:
        """Cosine-score active memories. Returns sorted (memory, similarity)
        list above the floor, capped at limit."""
        # Tuple-query the (id, embedding) pair for scoring so the deferred
        # `embedding` column is the only fat data pulled — full Memory ORM
        # objects (with content, context blobs) only get loaded for the
        # top-K rows the caller actually wants.
        q = db.query(Memory.id, Memory.embedding).filter(
            Memory.is_active == True,
            Memory.embedding.isnot(None),
        )
        if type_filter:
            q = q.filter(Memory.type.in_(type_filter))
        rows = q.all()
        scored_ids: list[tuple[int, float]] = []
        for mid, emb in rows:
            try:
                sim = _cosine_similarity(query_vec, json.loads(emb))
                if sim >= floor:
                    scored_ids.append((mid, sim))
            except Exception:
                continue
        scored_ids.sort(key=lambda x: x[1], reverse=True)
        top = scored_ids[:limit]
        if not top:
            return []
        ids = [mid for mid, _ in top]
        full = db.query(Memory).filter(Memory.id.in_(ids)).all()
        by_id = {m.id: m for m in full}
        return [(by_id[mid], sim) for mid, sim in top if mid in by_id]

    # ── reconcile/apply ─────────────────────────────────────────────────────

    def _apply_add(
        self,
        db: Session,
        candidate: dict,
        embedding: list[float],
        source_note_id: int | None = None,
    ) -> Memory:
        ctx = candidate.get("context")
        key = candidate.get("key")
        m = Memory(
            type=candidate["type"],
            key=key,
            content=candidate["content"][:MAX_CANDIDATE_LEN],
            context=json.dumps(ctx) if ctx else None,
            confidence=float(candidate.get("confidence", 0.8)),
            embedding=json.dumps(embedding) if embedding else None,
            source_note_id=source_note_id,
            is_active=True,
        )
        db.add(m)
        db.flush()  # need m.id to point superseded rows at it
        # Key uniqueness: only one active memory per (type, key). Older
        # rows with same key become inactive and point at the new row.
        # This is what makes contradiction handling robust — even if
        # reconcile didn't catch the contradiction, key collision does.
        if key:
            stale = (
                db.query(Memory)
                .filter(
                    Memory.id != m.id,
                    Memory.type == candidate["type"],
                    Memory.key == key,
                    Memory.is_active == True,
                )
                .all()
            )
            for old in stale:
                old.is_active = False
                old.superseded_by = m.id
        db.commit()
        db.refresh(m)
        return m

    def _apply_update(
        self,
        db: Session,
        candidate: dict,
        embedding: list[float],
        target_id: int,
        source_note_id: int | None = None,
    ) -> Memory:
        # Mark the old row inactive, point superseded_by at the new row.
        new_m = self._apply_add(db, candidate, embedding, source_note_id=source_note_id)
        old = db.query(Memory).filter(Memory.id == target_id).first()
        if old:
            old.is_active = False
            old.superseded_by = new_m.id
            db.commit()
        return new_m

    def _apply_delete(self, db: Session, target_id: int) -> None:
        old = db.query(Memory).filter(Memory.id == target_id).first()
        if old:
            old.is_active = False
            db.commit()

    def _apply_none(self, db: Session, target_id: int) -> None:
        # Boost confidence — this fact has now been observed twice.
        old = db.query(Memory).filter(Memory.id == target_id).first()
        if old:
            old.confidence = min(1.0, (old.confidence or 0.8) + 0.1)
            db.commit()

    # ── public interface ────────────────────────────────────────────────────

    def add_exchange(
        self,
        user_message: str,
        assistant_reply: str,
        db: Session | None = None,
    ) -> None:
        """Extract → reconcile → apply for a single chat turn. Failures are
        logged but never raised, since this runs after the response is sent.

        Legacy path. The orchestrator now uses the unified `extract_signals`
        and feeds candidates into `apply_memory_candidates` directly so we
        don't run two LLM extractions per turn. Kept for any callers that
        still want the old extract+apply convenience.
        """
        if not user_message or len(user_message.strip()) < MIN_EXCHANGE_LEN:
            return
        from .intent_handlers.memories import _reconcile_one

        sess, owns = self._scoped(db)
        try:
            candidates = extract_candidates(user_message, assistant_reply)
            for c in candidates:
                try:
                    _reconcile_one(sess, c)
                except Exception as e:
                    print(f"add_exchange per-candidate error: {e}")
            if candidates:
                self._has_memories_cache = True
        except Exception as e:
            print(f"memory add_exchange error: {e}")
        finally:
            if owns:
                sess.close()

    def apply_memory_candidates(
        self,
        candidates: list[dict],
        db: Session | None = None,
        source_note_id: int | None = None,
    ) -> list[Memory]:
        """Reconcile + apply pre-extracted memory candidates. Returns the
        list of Memory rows actually written (ADDs + UPDATEs).

        Thin shim around `intent_handlers.memories._reconcile_one` — the
        per-candidate dance (cosine + key search → LLM reconcile → apply)
        was extracted to the handler in phase 3 so memory_service stays a
        CRUD primitive layer. This method is kept for backward compat;
        new callers should go through `intent_router.dispatch`.

        Failures logged, never raised.
        """
        if not candidates:
            return []
        from .intent_handlers.memories import _reconcile_one

        written: list[Memory] = []
        sess, owns = self._scoped(db)
        try:
            for c in candidates:
                try:
                    m = _reconcile_one(sess, c, source_note_id=source_note_id)
                except Exception as e:
                    print(f"apply_memory_candidates per-candidate error: {e}")
                    continue
                if m is not None:
                    written.append(m)
            self._has_memories_cache = True
        except Exception as e:
            print(f"apply_memory_candidates error: {e}")
        finally:
            if owns:
                sess.close()
        return written

    def add_feedback_preference(
        self,
        rule: str,
        evidence: str,
        db: Session | None = None,
        anti_pattern: str = "",
    ) -> Memory | None:
        """Persist a tone-correction rule from chat feedback.

        Goes through the same reconcile path as `add_exchange` so a repeated
        rule supersedes the older row instead of stacking. Stored as
        type='preference' so it's always injected into the system prompt by
        `build_memory_context`.

        `evidence` is the offending phrase from the prior assistant reply that
        triggered Daniel's correction. `anti_pattern` is a concrete bad
        example for future-Gooni to recognize. Both are appended to the
        stored content when present so the system prompt teaches future
        Gooni *what specifically to avoid*, not just an abstract rule.
        """
        rule = (rule or "").strip()
        if not rule:
            return None
        # Compose stored content. Future Gooni reads this verbatim; richer
        # phrasing (with concrete pattern) generalizes better than a bland
        # rule like "less directive".
        parts = [rule]
        anti = (anti_pattern or "").strip()
        if anti:
            parts.append(f'(avoid e.g. "{anti}")')
        ev = (evidence or "").strip()
        if ev and not anti:
            # Only fall back to evidence in the content if anti_pattern is
            # missing — anti_pattern is the cleaner future-facing signal.
            parts.append(f'(triggered by: "{ev[:120]}")')
        content = " ".join(parts)
        candidate = {
            "type": "preference",
            "key": _slug_rule(rule),
            "content": content,
            "context": {"time": None, "location": None, "scope": "global"},
            "confidence": 0.9,
        }
        from .intent_handlers.memories import _reconcile_one

        sess, owns = self._scoped(db)
        try:
            _reconcile_one(sess, candidate)
            self._has_memories_cache = True
            # Return the freshly-inserted/active row for this key for caller
            # convenience (e.g. so we can link it to the audit page later).
            return (
                sess.query(Memory)
                .filter(
                    Memory.type == "preference",
                    Memory.key == candidate["key"],
                    Memory.is_active == True,
                )
                .order_by(Memory.id.desc())
                .first()
            )
        except Exception as e:
            print(f"memory add_feedback_preference error: {e}")
            return None
        finally:
            if owns:
                sess.close()

    def deactivate_last_feedback_preference(
        self, db: Session | None = None
    ) -> Memory | None:
        """Mark the most recently added feedback-derived preference inactive.

        Used by the orchestrator's "undo last feedback" command. Only affects
        active preferences whose key starts with the feedback prefix used by
        `_slug_rule` — leaves user-curated preferences alone.
        """
        sess, owns = self._scoped(db)
        try:
            row = (
                sess.query(Memory)
                .filter(
                    Memory.type == "preference",
                    Memory.is_active == True,
                    Memory.key.like(f"{_FEEDBACK_KEY_PREFIX}%"),
                )
                .order_by(Memory.id.desc())
                .first()
            )
            if not row:
                return None
            row.is_active = False
            sess.commit()
            return row
        finally:
            if owns:
                sess.close()

    def add_memory(
        self,
        content: str,
        type: str = "episode",
        db: Session | None = None,
    ) -> Memory | None:
        """Direct write — bypasses extraction. Used by MCP, focus mirrors,
        note memorize. Default type is 'episode' (free-form chat extract).
        """
        if not content or not content.strip():
            return None
        sess, owns = self._scoped(db)
        try:
            embedding = self._embed(content)
            m = self._apply_add(
                sess,
                {"type": type, "content": content, "confidence": 0.8},
                embedding or [],
            )
            self._has_memories_cache = True
            return m
        except Exception as e:
            print(f"memory add_memory error: {e}")
            return None
        finally:
            if owns:
                sess.close()

    def build_memory_context(
        self, query: str, db: Session | None = None
    ) -> str:
        """Format the system-prompt memory block. Preferences always go in;
        facts + episodes ride semantic similarity to the query.
        """
        text, _debug = self.build_memory_context_with_debug(query, db=db)
        return text

    def build_memory_context_with_debug(
        self, query: str, db: Session | None = None
    ) -> tuple[str, list[dict]]:
        """Same as build_memory_context but also returns a list describing
        every memory injected into the prompt. Each entry is:
          {"id": int, "type": str, "content": str,
           "similarity": float | None, "always_inject": bool}
        Preferences carry similarity=None + always_inject=True; cosine-
        retrieved rows carry the actual score. Used by the eval visualizer
        to show what informed Gooni this turn.
        """
        sess, owns = self._scoped(db)
        try:
            all_prefs = (
                sess.query(Memory)
                .filter(Memory.type == "preference", Memory.is_active == True)
                .order_by(Memory.created_at.desc())
                .all()
            )
            # Manually-curated prefs (no feedback prefix) always inject.
            # Feedback-derived prefs (auto-written from tone corrections) are
            # capped at FEEDBACK_PREF_CAP most-recent so the prompt doesn't
            # bloat to 50+ rules over time.
            curated: list[Memory] = []
            feedback: list[Memory] = []
            for m in all_prefs:
                if (m.key or "").startswith(_FEEDBACK_KEY_PREFIX):
                    feedback.append(m)
                else:
                    curated.append(m)
            prefs = curated + feedback[:FEEDBACK_PREF_CAP]
            facts: list[Memory] = []
            episodes: list[Memory] = []
            scored: list[tuple[Memory, float]] = []
            if query and len(query.strip()) >= MIN_EXCHANGE_LEN:
                query_vec = self._embed(query)
                if query_vec:
                    for mem_type, cfg in RETRIEVAL_PER_TYPE.items():
                        hits = self._cosine_search(
                            sess,
                            query_vec,
                            type_filter=[mem_type],
                            limit=int(cfg["top_k"]),
                            floor=float(cfg["floor"]),
                        )
                        scored.extend(hits)
                        for m, _ in hits:
                            if m.type == "episode":
                                episodes.append(m)
                            else:
                                facts.append(m)
                    # Within-section sort by similarity desc, so stronger matches
                    # render first under each header in the prompt.
                    sim_map = {m.id: s for m, s in scored}
                    facts.sort(key=lambda m: sim_map.get(m.id, 0.0), reverse=True)
                    episodes.sort(key=lambda m: sim_map.get(m.id, 0.0), reverse=True)

            sim_lookup = {m.id: s for m, s in scored}
            debug: list[dict] = []
            for m in prefs:
                debug.append({
                    "id": m.id,
                    "type": m.type,
                    "content": m.content,
                    "similarity": None,
                    "always_inject": True,
                })
            for m in facts + episodes:
                debug.append({
                    "id": m.id,
                    "type": m.type,
                    "content": m.content,
                    "similarity": sim_lookup.get(m.id),
                    "always_inject": False,
                })
            # Bump retrieval tracking on cosine-pulled rows only. Always-inject
            # prefs are excluded — their count would equal turn count and tell
            # us nothing about which memories actually earn their slot.
            cosine_ids = [m.id for m in facts + episodes]
            if cosine_ids:
                try:
                    sess.execute(
                        sa_update(Memory)
                        .where(Memory.id.in_(cosine_ids))
                        .values(
                            retrieval_count=Memory.retrieval_count + 1,
                            last_retrieved_at=datetime.utcnow(),
                        )
                    )
                    sess.commit()
                except Exception as e:
                    print(f"memory retrieval bump error: {e}")
                    sess.rollback()
            base_block = self._format_block(prefs, facts, episodes)
            # Prepend the capability profile so Gooni grounds "I can / I can't"
            # answers in verified facts instead of hallucinating. The block is
            # capped at ~30 lines inside capability_service so the prompt
            # doesn't bloat over time. Imported lazily to avoid a circular
            # import at module load (capability_service → main → memory).
            try:
                from .capability_service import capability_service
                cap_block = capability_service.build_prompt_block(sess)
            except Exception as e:
                print(f"capability prompt block error: {e}")
                cap_block = ""
            full_block = "\n\n".join([b for b in (cap_block, base_block) if b])
            return full_block, debug
        finally:
            if owns:
                sess.close()

    def _format_block(
        self,
        preferences: list[Memory],
        facts: list[Memory],
        episodes: list[Memory],
    ) -> str:
        if not preferences and not facts and not episodes:
            return ""
        lines = []
        if preferences:
            lines.append("Daniel's preferences (always apply):")
            for m in preferences:
                lines.append(f"- {m.content}")
        if facts:
            lines.append("\nRelevant facts about Daniel:")
            for m in facts:
                lines.append(f"- {m.content}")
        if episodes:
            lines.append("\nRelevant past context:")
            for m in episodes:
                snippet = (m.content or "")[:200].replace("\n", " ")
                lines.append(f"- {snippet}")
        return "\n".join(lines)

    def search(
        self, query: str, limit: int = 8, db: Session | None = None
    ) -> list[dict]:
        """Semantic search across all active memories. Returns dict shape
        compatible with the old Mem0-backed routes (id + memory keys).
        """
        sess, owns = self._scoped(db)
        try:
            query_vec = self._embed(query)
            if not query_vec:
                return []
            hits = self._cosine_search(sess, query_vec, limit=limit)
            return [_serialize(m) for m, _ in hits]
        finally:
            if owns:
                sess.close()

    def get_all(self, db: Session | None = None) -> list[dict]:
        sess, owns = self._scoped(db)
        try:
            rows = (
                sess.query(Memory)
                .filter(Memory.is_active == True)
                .order_by(Memory.created_at.desc())
                .all()
            )
            return [_serialize(m) for m in rows]
        finally:
            if owns:
                sess.close()

    def delete(self, memory_id, db: Session | None = None) -> bool:
        """Soft delete — marks is_active=False so audit chain survives.
        Accepts int or numeric string id (MCP routes pass strings).
        """
        try:
            mid = int(memory_id)
        except (ValueError, TypeError):
            return False
        sess, owns = self._scoped(db)
        try:
            m = sess.query(Memory).filter(Memory.id == mid).first()
            if not m:
                return False
            m.is_active = False
            sess.commit()
            return True
        finally:
            if owns:
                sess.close()

    def update_memory(
        self, memory_id, content: str, db: Session | None = None
    ) -> bool:
        """Replace a memory's content via supersede chain. Old is_active
        flips to False, new row inherits type/key. Used by MCP edit_memory.
        """
        try:
            mid = int(memory_id)
        except (ValueError, TypeError):
            return False
        sess, owns = self._scoped(db)
        try:
            old = sess.query(Memory).filter(Memory.id == mid).first()
            if not old:
                return False
            embedding = self._embed(content) or []
            new_m = Memory(
                type=old.type,
                key=old.key,
                content=content[:MAX_CANDIDATE_LEN],
                context=old.context,
                confidence=old.confidence,
                embedding=json.dumps(embedding) if embedding else None,
                focus_id=old.focus_id,
                is_active=True,
            )
            sess.add(new_m)
            sess.flush()
            old.is_active = False
            old.superseded_by = new_m.id
            sess.commit()
            return True
        finally:
            if owns:
                sess.close()

    def has_memories(self, db: Session | None = None) -> bool:
        if self._has_memories_cache is not None:
            return self._has_memories_cache
        sess, owns = self._scoped(db)
        try:
            n = (
                sess.query(Memory)
                .filter(Memory.is_active == True)
                .count()
            )
            self._has_memories_cache = n > 0
            return self._has_memories_cache
        finally:
            if owns:
                sess.close()


memory_service = MemoryService()
