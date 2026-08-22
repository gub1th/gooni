"""`classify_note` — the note-side entry into the shared intent pipeline.

Runs the extractor over a settled note and dispatches its signals through
`intent_router`, the SAME dispatch point chat uses. Its dedup gate is a
cosine comparison against `classified_embedding`, which is why a typo fix
re-embeds (cheap, exact) without paying for a re-extraction.
"""

import json

from ...db.models import Note
from ...utils.embeddings import cosine_similarity as _cosine_similarity
from .service import NoteService


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
    from ...db.database import SessionLocal
    from ..memory_extraction import extract_signals

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
        from ...common import local_today
        signals = extract_signals(text_for_llm, prev_assistant=None, today=local_today(db))

        # Unified routing via intent_router — same dispatch point chat
        # uses, eliminates the two-layer drift that caused the
        # "demo for gooni" bug (note #258 phase 2). Tone + promise
        # handlers self-skip without prev_assistant / source_message.
        from .. import intent_router
        ctx = intent_router.RouterContext(
            db=db,
            source_note_id=note.id,
        )
        routed = intent_router.dispatch(signals, ctx)
        memories_written = routed.memories_written

        # Map router's captured_features (title + note_id) into the note's
        # signals_summary shape. `list_item_id` stays as the historical key
        # name so the FE disclosure renders unchanged — it is a Note id and
        # has been since the v2 nuke.
        feature_summaries = [
            {"title": f["title"], "list_item_id": f["note_id"]}
            for f in routed.captured_features
            if f.get("note_id") is not None
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
