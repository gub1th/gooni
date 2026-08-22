"""The note sweeper — when embedding and classification actually run."""

from ...db.models import Note
from .classify import classify_note
from .service import note_service


# How long a note must sit untouched before it is worth embedding/classifying.
# Notes are edited in bursts; embedding mid-burst pays for a draft state and
# the extractor reads a half-written thought. An hour is long enough that a
# note has settled and short enough that recall is same-session-useful.
SWEEP_IDLE_SECONDS = 3600
# Bound on one pass, so a first run over a large backlog can't spend an
# unbounded number of API calls or hold a session open for minutes.
SWEEP_BATCH = 20


def sweep_stale_notes(
    limit: int = SWEEP_BATCH,
    dry_run: bool = False,
    classify: bool = True,
) -> dict:
    """Embed + classify notes that have gone quiet. THE processing path.

    Both halves used to run on the write path (blur, dirty-leave, submit), so
    one editing session could burn several embedding calls and several
    gpt-5.4-mini extractions on successive half-finished states of the same
    note. Nothing about either job wants to be synchronous — the embedding
    feeds search and the extractor feeds memory, and neither is read in the
    seconds after a keystroke.

    Idle-time IS the dedup gate, and a better one than a content hash: it also
    stops mid-typing states from ever reaching the extractor.

    Archived notes are skipped — they are out of every browsing and search
    surface, so paying to embed one buys nothing; unarchiving leaves it due
    and the next sweep picks it up.

    Fails per-note, not per-batch: one bad note must not strand the queue
    behind it. Returns a count summary for the loop to log.

    `dry_run=True` reports what WOULD be processed and spends zero API calls.
    That exists because every other way to check this function's query is to
    run it, and running it embeds, extracts, and writes memories — the first
    tick against a real database is a backlog of every note that ever existed.

    `classify=False` embeds only. THE BACKFILL SETTING, and the reason it
    exists: `classify_note`'s cosine gate protects notes that were already
    classified once, but a note that has never been embedded has no
    `classified_embedding` either, so it sails past the gate and runs a full
    extraction — which WRITES, minting memories and feature-request notes
    through `intent_router`. Draining a years-old backlog with classify on
    would flood the memory table with rows extracted from notes nobody
    touched, which is precisely the failure `/notes/{id}/memorize` was
    deleted for. Embed first (search works, gate gets populated), classify
    only what is genuinely edited afterwards.
    """
    from datetime import datetime, timedelta

    from ...db.database import SessionLocal
    from ...serializers import _not_archived

    cutoff = datetime.utcnow() - timedelta(seconds=SWEEP_IDLE_SECONDS)
    db = SessionLocal()
    try:
        due = (
            _not_archived(db.query(Note.id))
            .filter(
                Note.updated_at.isnot(None),
                Note.updated_at < cutoff,
                # Never embedded, or embedded against older content.
                (Note.embedded_at.is_(None)) | (Note.embedded_at < Note.updated_at),
            )
            .order_by(Note.updated_at.desc())
            .limit(limit)
            .all()
        )
        note_ids = [row[0] for row in due]
    finally:
        db.close()

    if dry_run:
        return {"due": len(note_ids), "processed": 0, "failed": 0, "dry_run": True}


    embedded = 0
    failed = 0
    for note_id in note_ids:
        try:
            # Each opens/closes its own session; classify_note additionally
            # runs its own cosine dedup gate, so a typo fix re-embeds (cheap,
            # exact) without paying for a re-extraction (expensive, fuzzy).
            note_service.update_embedding(note_id)
            if classify:
                classify_note(note_id)
            embedded += 1
        except Exception as e:
            failed += 1
            print(f"[note-sweep] note {note_id}: {e}", flush=True)

    return {"due": len(note_ids), "processed": embedded, "failed": failed}
