import json
import math
import re

from sqlalchemy.orm import Session

from ..db.models import Note, Space
from ..llm.client import llm_client


def _cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    if not vec1 or not vec2:
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    mag1 = math.sqrt(sum(a * a for a in vec1))
    mag2 = math.sqrt(sum(b * b for b in vec2))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    return dot / (mag1 * mag2)


class NoteService:
    @staticmethod
    def _strip_html(html: str) -> str:
        return re.sub(r"<[^>]+>", " ", html or "").strip()

    def update_embedding(self, note_id: int) -> None:
        """Background task: generate and store an embedding for a note.
        Opens its own DB session since it runs after the HTTP response is sent.
        """
        from ..db.database import SessionLocal

        db = SessionLocal()
        try:
            note = db.query(Note).filter(Note.id == note_id).first()
            if not note:
                return
            raw = f"{note.title or ''}\n{self._strip_html(note.content or '')}".strip()
            if not raw:
                return
            embedding, _ = llm_client.generate_embedding(raw)
            if embedding:
                note.embedding = json.dumps(embedding)
                db.commit()
        except Exception as e:
            print(f"Note embedding error: {e}")
        finally:
            db.close()

    def get_related(self, note_id: int, limit: int, db: Session) -> list[Note]:
        """Return notes most similar to the given note by cosine similarity."""
        note = db.query(Note).filter(Note.id == note_id).first()
        if not note or not note.embedding:
            return []
        query_vec = json.loads(note.embedding)
        candidates = (
            db.query(Note)
            .filter(Note.id != note_id, Note.embedding.isnot(None))
            .all()
        )
        scored = []
        for n in candidates:
            try:
                sim = _cosine_similarity(query_vec, json.loads(n.embedding))
                scored.append((n, sim))
            except Exception:
                pass
        scored.sort(key=lambda x: x[1], reverse=True)
        return [n for n, _ in scored[:limit]]

    def suggest_space(self, note_id: int, db: Session) -> dict:
        """Return best-matching space for a note based on embedding similarity.
        Only suggests when the note is in General (space_id is None).
        """
        note = db.query(Note).filter(Note.id == note_id).first()
        if not note or not note.embedding or note.space_id is not None:
            return {"suggested_space_id": None, "suggested_space_name": None, "suggested_space_emoji": None}

        note_vec = json.loads(note.embedding)
        spaces = db.query(Space).all()
        best_space = None
        best_sim = 0.60  # minimum threshold to suggest

        for space in spaces:
            space_notes = (
                db.query(Note)
                .filter(Note.space_id == space.id, Note.id != note_id, Note.embedding.isnot(None))
                .all()
            )
            if not space_notes:
                continue
            vecs = [json.loads(n.embedding) for n in space_notes]
            centroid = [sum(v[i] for v in vecs) / len(vecs) for i in range(len(vecs[0]))]
            sim = _cosine_similarity(note_vec, centroid)
            if sim > best_sim:
                best_sim = sim
                best_space = space

        if best_space:
            return {
                "suggested_space_id": best_space.id,
                "suggested_space_name": best_space.name,
                "suggested_space_emoji": best_space.emoji,
            }
        return {"suggested_space_id": None, "suggested_space_name": None, "suggested_space_emoji": None}

    def search_by_query(self, query: str, limit: int, db: Session) -> list[Note]:
        """Search notes by semantic similarity to a query string."""
        query_embedding, _ = llm_client.generate_embedding(query)
        if not query_embedding:
            return []
        candidates = db.query(Note).filter(Note.embedding.isnot(None)).all()
        scored = []
        for n in candidates:
            try:
                sim = _cosine_similarity(query_embedding, json.loads(n.embedding))
                scored.append((n, sim))
            except Exception:
                pass
        scored.sort(key=lambda x: x[1], reverse=True)
        return [n for n, _ in scored[:limit]]


note_service = NoteService()


# ── Note classification (unified extractor) ─────────────────────────────────
# Runs the same extract_signals pipeline used in chat against note bodies so
# notes about Gooni gaps land in the Backlog space without Daniel needing to
# open a chat. Dedup gate uses an embedding snapshot so typos / minor edits
# don't re-trigger and create duplicate Backlog rows.

# Cosine threshold above which we treat the note's meaning as "unchanged"
# since the last classification. Tuned to skip wording polish / typos but
# fire on additions of new ideas. Adjustable.
_CLASSIFY_DEDUP_THRESHOLD = 0.92

# Minimum plaintext length before we even attempt classification — empty
# or scratchpad-sized notes carry no signal.
_CLASSIFY_MIN_CHARS = 30


def classify_note(note_id: int) -> None:
    """Background-safe: open own session, classify the note, route signals
    into the same memory + backlog pipelines the chat orchestrator uses.

    Idempotency: if `note.classified_embedding` is set and cosine similarity
    against the current embedding is >= threshold, this is a no-op. So
    typos and minor edits won't generate duplicate Backlog rows.
    """
    from ..db.database import SessionLocal
    from .memory_extraction import extract_signals
    from .memory_service import memory_service
    from ..tools.feature_request_tool import feature_request_tool

    db = SessionLocal()
    try:
        note = db.query(Note).filter(Note.id == note_id).first()
        if not note:
            return
        plaintext = NoteService._strip_html(note.content or "").strip()
        if len(plaintext) < _CLASSIFY_MIN_CHARS:
            return

        # Dedup gate: skip if meaning hasn't materially shifted since last
        # classification. Compares the live note embedding to the snapshot
        # taken at the moment we last classified.
        if note.embedding and note.classified_embedding:
            try:
                live_vec = json.loads(note.embedding)
                snap_vec = json.loads(note.classified_embedding)
                sim = _cosine_similarity(live_vec, snap_vec)
                if sim >= _CLASSIFY_DEDUP_THRESHOLD:
                    return
            except Exception as e:
                print(f"classify_note dedup compare error: {e}")
                # fall through and re-classify

        text_for_llm = f"{(note.title or '').strip()}\n\n{plaintext}".strip()
        signals = extract_signals(text_for_llm, prev_assistant=None)

        # Memories: route through the same reconciler as chat. Tag each
        # written row with source_note_id so the editor disclosure can
        # surface "this note created N memories".
        memories_written: list = []
        if signals["memories"]:
            memories_written = memory_service.apply_memory_candidates(
                signals["memories"], db=db, source_note_id=note.id,
            )

        # Feature requests: write items to the canonical Backlog List. Each
        # ListItem carries source_note_id back to this note. We capture the
        # ids so the editor disclosure can deep-link to each new item.
        feature_summaries: list[dict] = []
        for fr in signals["feature_requests"]:
            try:
                result = feature_request_tool.execute(
                    db=db,
                    title=fr["title"],
                    why=fr.get("why")
                        or f"From note #{note.id}: {plaintext[:200]}",
                    source_note_id=note.id,
                )
                # Tool returns "Logged feature request #N: title" — extract id
                import re as _re
                m = _re.search(r"#(\d+)", result or "")
                if m:
                    feature_summaries.append({
                        "title": fr["title"],
                        "list_item_id": int(m.group(1)),
                    })
            except Exception as e:
                print(f"classify_note feature_request error: {e}")

        # Persist the signals snapshot so the editor can render a "Routed:"
        # disclosure mirroring the chat bubble. Empty payload still writes
        # so the frontend can tell "yes we classified, no signals" apart
        # from "haven't classified yet".
        from datetime import datetime, timezone
        signals_summary = {
            "feature_requests": feature_summaries,
            "memory_count": len(memories_written),
            "memory_types": [m.type for m in memories_written],
            "classified_at": datetime.now(timezone.utc).isoformat(),
        }
        note.last_classify_signals = json.dumps(signals_summary)

        # Snapshot the embedding we just classified against. Future saves
        # will compare against this to decide whether to re-run.
        if note.embedding:
            note.classified_embedding = note.embedding

        db.commit()
    except Exception as e:
        print(f"classify_note error: {e}")
    finally:
        db.close()
