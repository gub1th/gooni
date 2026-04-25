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

# Number of similar existing memories pulled per candidate during reconcile.
RECONCILE_TOP_K = 3

# Retrieval limits when injecting into the system prompt.
RETRIEVAL_TOP_K = 5

# Max content length for an extracted candidate before we drop it as garbage.
MAX_CANDIDATE_LEN = 600


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
        q = db.query(Memory).filter(
            Memory.is_active == True,
            Memory.embedding.isnot(None),
        )
        if type_filter:
            q = q.filter(Memory.type.in_(type_filter))
        rows = q.all()
        scored: list[tuple[Memory, float]] = []
        for m in rows:
            try:
                vec = json.loads(m.embedding)
                sim = _cosine_similarity(query_vec, vec)
                if sim >= floor:
                    scored.append((m, sim))
            except Exception:
                continue
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:limit]

    # ── reconcile/apply ─────────────────────────────────────────────────────

    def _apply_add(
        self, db: Session, candidate: dict, embedding: list[float]
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
    ) -> Memory:
        # Mark the old row inactive, point superseded_by at the new row.
        new_m = self._apply_add(db, candidate, embedding)
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
        """
        if not user_message or len(user_message.strip()) < MIN_EXCHANGE_LEN:
            return
        sess, owns = self._scoped(db)
        try:
            candidates = extract_candidates(user_message, assistant_reply)
            for c in candidates:
                self._reconcile_and_apply(sess, c)
            if candidates:
                self._has_memories_cache = True
        except Exception as e:
            print(f"memory add_exchange error: {e}")
        finally:
            if owns:
                sess.close()

    def _reconcile_and_apply(self, db: Session, candidate: dict) -> None:
        embedding = self._embed(candidate["content"])
        # Skip embedding-less candidates only on the search side; we still
        # want to ADD them so the memory isn't lost.
        existing: list[dict] = []
        seen_ids: set[int] = set()

        # Key-based retrieval first — catches "prefers dark mode" → "prefers
        # light mode" contradictions where cosine sim is misleadingly low
        # (opposing facts share less language than they should).
        candidate_key = candidate.get("key")
        if candidate_key:
            key_matches = (
                db.query(Memory)
                .filter(
                    Memory.key == candidate_key,
                    Memory.type == candidate["type"],
                    Memory.is_active == True,
                )
                .all()
            )
            for m in key_matches:
                if m.id not in seen_ids:
                    seen_ids.add(m.id)
                    existing.append(_serialize(m))

        if embedding:
            similar = self._cosine_search(
                db,
                embedding,
                type_filter=[candidate["type"]],
                limit=RECONCILE_TOP_K,
                floor=RECONCILE_SIMILARITY_FLOOR,
            )
            for m, _ in similar:
                if m.id not in seen_ids:
                    seen_ids.add(m.id)
                    existing.append(_serialize(m))
            existing = existing[:RECONCILE_TOP_K + 2]  # cap so prompt stays bounded

        decision = reconcile_candidate(candidate, existing)
        if not decision:
            # Reconcile bombed — fall back to ADD so we don't lose the fact.
            self._apply_add(db, candidate, embedding or [])
            return

        action = decision["action"]
        target = decision.get("target_id")
        if action == "ADD":
            self._apply_add(db, candidate, embedding or [])
        elif action == "UPDATE" and isinstance(target, int):
            self._apply_update(db, candidate, embedding or [], target)
        elif action == "DELETE" and isinstance(target, int):
            self._apply_delete(db, target)
            # Also ADD the contradicting candidate so the new state is captured.
            self._apply_add(db, candidate, embedding or [])
        elif action == "NONE" and isinstance(target, int):
            self._apply_none(db, target)
        else:
            # Unrecognized — default to ADD to preserve information
            self._apply_add(db, candidate, embedding or [])

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
        if not query or len(query.strip()) < MIN_EXCHANGE_LEN:
            # For trivial queries we still want preferences — they're cheap
            # and always relevant. Just skip semantic recall.
            sess, owns = self._scoped(db)
            try:
                prefs = (
                    sess.query(Memory)
                    .filter(Memory.type == "preference", Memory.is_active == True)
                    .all()
                )
                return self._format_block(prefs, [], [])
            finally:
                if owns:
                    sess.close()

        sess, owns = self._scoped(db)
        try:
            prefs = (
                sess.query(Memory)
                .filter(Memory.type == "preference", Memory.is_active == True)
                .all()
            )
            query_vec = self._embed(query)
            facts: list[Memory] = []
            episodes: list[Memory] = []
            if query_vec:
                # Semantic search across non-preference active memories
                hits = self._cosine_search(
                    sess,
                    query_vec,
                    type_filter=["fact", "goal", "routine", "constraint", "episode"],
                    limit=RETRIEVAL_TOP_K,
                )
                for m, _ in hits:
                    if m.type == "episode":
                        episodes.append(m)
                    else:
                        facts.append(m)
            return self._format_block(prefs, facts, episodes)
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
