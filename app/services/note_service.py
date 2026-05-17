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

    def suggest_space(self, note_id: int, db: Session) -> dict:
        """Return best-matching space for a note based on embedding similarity.
        Only suggests when the note is in General (space_id is None).
        """
        # Tuple query — skips ORM hydration of all the other columns we
        # don't need (content, title, classify_signals, etc) and only the
        # deferred embedding actually loads. Saves ~MB per call when the
        # note body is fat or there are many candidates.
        row = (
            db.query(Note.embedding, Note.space_id)
            .filter(Note.id == note_id)
            .first()
        )
        if not row or not row[0] or row[1] is not None:
            return {"suggested_space_id": None, "suggested_space_name": None, "suggested_space_emoji": None}
        note_vec = json.loads(row[0])
        spaces = db.query(Space).all()
        best_space = None
        best_sim = 0.60  # minimum threshold to suggest

        for space in spaces:
            space_notes = (
                db.query(Note.embedding)
                .filter(Note.space_id == space.id, Note.id != note_id, Note.embedding.isnot(None))
                .all()
            )
            if not space_notes:
                continue
            vecs = [json.loads(emb) for (emb,) in space_notes]
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
        # Two-pass: first score every candidate with a tiny tuple query
        # (id, embedding) — skips materializing full Note ORM objects with
        # their fat content columns. Then load only the top-K full rows.
        candidates = (
            db.query(Note.id, Note.embedding)
            .filter(Note.embedding.isnot(None))
            .all()
        )
        scored: list[tuple[int, float]] = []
        for nid, emb in candidates:
            try:
                sim = _cosine_similarity(query_embedding, json.loads(emb))
                scored.append((nid, sim))
            except Exception:
                pass
        scored.sort(key=lambda x: x[1], reverse=True)
        top_ids = [nid for nid, _ in scored[:limit]]
        if not top_ids:
            return []
        rows = db.query(Note).filter(Note.id.in_(top_ids)).all()
        # Restore the cosine ordering.
        by_id = {n.id: n for n in rows}
        return [by_id[nid] for nid in top_ids if nid in by_id]


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
# or scratchpad-sized notes carry no signal. Tuned low because topic-shape
# notes ("cursor for content creators", "ambient kitchen device") deserve
# classification even though they're short. The LLM still rejects truly
# trivial inputs with empty signal arrays.
_CLASSIFY_MIN_CHARS = 8


def classify_note(note_id: int) -> None:
    """Background-safe: open own session, classify the note, route signals
    into the same memory + backlog pipelines the chat orchestrator uses.

    Idempotency: if `note.classified_embedding` is set and cosine similarity
    against the current embedding is >= threshold, this is a no-op. So
    typos and minor edits won't generate duplicate Backlog rows.
    """
    from ..db.database import SessionLocal
    from .memory_extraction import extract_signals

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

        # Unified routing via intent_router — same dispatch point chat
        # uses, eliminates the two-layer drift that caused the
        # "demo for gooni" bug (note #258 phase 2). Tone + promise
        # handlers self-skip without prev_assistant / source_message.
        from . import intent_router
        ctx = intent_router.RouterContext(
            db=db,
            source_note_id=note.id,
        )
        routed = intent_router.dispatch(signals, ctx)
        memories_written = routed.memories_written

        # Map router's captured_features (title + ticket_id) into the
        # note's signals_summary shape. list_item_id stays as the
        # historical key name so the FE disclosure renders unchanged.
        feature_summaries = [
            {"title": f["title"], "list_item_id": f["ticket_id"]}
            for f in routed.captured_features
            if f.get("ticket_id") is not None
        ]

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
