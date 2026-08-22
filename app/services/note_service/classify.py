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

        # ONE capture path, shared with the chat orchestrator. This used to be
        # a hand-rolled extract -> dispatch -> summarize block that had
        # drifted from the chat one in two ways; see services/capture.py.
        from .. import intent_router
        from ..capture import capture

        ctx = intent_router.RouterContext(db=db, source_note_id=note.id)
        # route_memories=True: a note is a settled artifact, so its memory
        # candidates are written directly. Chat passes False and reconciles
        # off-thread instead. The two callers genuinely differ here and the
        # difference is now stated at the call site rather than buried in
        # two adapters that disagreed silently.
        result = capture(text_for_llm, ctx, db=db, route_memories=True)

        # EXTRACT FAILED -> write the summary, but DO NOT snapshot the dedup
        # embedding. That snapshot is what tells the next sweep "this note's
        # meaning hasn't moved, skip it" — stamping it after a failed
        # extraction retired the note permanently with its captures lost,
        # and the stored summary was byte-identical to a clean "nothing to
        # capture". The chat side has always guarded this; the note side
        # never did.
        note.last_classify_signals = json.dumps(result.summary)
        if result.failed:
            db.commit()
            return

        # Snapshot the embedding we just classified against. Future saves
        # will compare against this to decide whether to re-run.
        if note.embedding:
            note.classified_embedding = note.embedding

        db.commit()
    except Exception as e:
        print(f"classify_note error: {e}")
    finally:
        db.close()
