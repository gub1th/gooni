#!/usr/bin/env python3
"""Embed the thought-notes that `_embed_note_async` never managed to embed.

`focus_service._embed_note_async` imported the note_service MODULE and called
`update_embedding` on it — a method that only exists on the `NoteService`
INSTANCE — so every logged thought since the function was written has been a
`Note` with a NULL embedding, and semantic search has never returned one. The
import is fixed; this catches up the rows already on disk.

Scope is exactly the two thought subtypes: Notes tagged `thought` (a single
logged thought) or `thought-batch` (a run of thinking). Ordinary notes have
their own embed path and are not touched.

    # what needs doing — read-only, no API calls, no writes
    python scripts/backfill_thought_embeddings.py --dry-run

    # embed the first 25, then check the remaining count again
    python scripts/backfill_thought_embeddings.py --limit 25

    # everything pending (each row is one paid embedding call)
    python scripts/backfill_thought_embeddings.py --all

Idempotent: a row with an embedding is never re-embedded, so re-running after
an interruption or a rate-limit resumes rather than repeats. Every run prints
the total pending BEFORE doing any work, because each row costs money.

Writes to whatever DB `DATABASE_URL` / the repo `.env` points at. There is no
remote mode on purpose — run it against a local copy first.

Exit 0 = ran (including "nothing to do"); 1 = argument error or a hard failure;
2 = finished with per-row failures, so the pending count did not reach zero.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

THOUGHT_TAGS = ("thought", "thought-batch")

# Between rows. The embedding endpoint is rate-limited and a backfill is the
# one caller that hammers it in a tight loop; a small pause is cheaper than
# hitting the limit and losing the rest of the batch.
SLEEP_BETWEEN = 0.1


def _load_local_env() -> None:
    """Load the repo-root .env for local runs (existing env always wins)."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _pending_query(db, Note):
    """Thought-notes with no embedding.

    `Note.embedding` is a deferred column, so this selects id/title/content
    explicitly rather than loading entities — the whole table's vectors would
    otherwise come along for a count.

    The tag test is the documented `_tagged` pattern from `focus_service`: a
    LIKE on the QUOTED token against the JSON list, which can't partial-match
    (`"thought"` never matches `"thoughtful"` because the quotes bound it).
    Empty-string embeddings count as pending alongside NULL — nothing writes
    one today, but treating `''` as embedded would silently strand a row.
    """
    from sqlalchemy import or_

    tag_filter = or_(*[Note.tags.like(f'%"{t}"%') for t in THOUGHT_TAGS])
    return (
        db.query(Note.id, Note.title, Note.content)
        .filter(tag_filter)
        .filter(or_(Note.embedding.is_(None), Note.embedding == ""))
        .order_by(Note.id.asc())
    )


def _has_text(note_service, title, content) -> bool:
    """Mirror `update_embedding`'s own early-return.

    It builds `title\\n<stripped content>` and bails if that's blank. Such a
    row can never gain an embedding, so counting it as pending would mean the
    pending count never reaches zero no matter how many times this is run.
    Report it as skipped instead.
    """
    return bool(f"{title or ''}\n{note_service._strip_html(content or '')}".strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="report the pending count and exit. No API calls, no writes.",
    )
    mode.add_argument(
        "--limit",
        type=int,
        metavar="N",
        help="embed at most N pending rows (oldest first).",
    )
    mode.add_argument(
        "--all",
        action="store_true",
        help="embed every pending row. One paid API call each.",
    )
    ap.add_argument("-v", "--verbose", action="store_true", help="print each row")
    args = ap.parse_args()

    if args.limit is not None and args.limit < 1:
        print("--limit must be >= 1", file=sys.stderr)
        return 1

    _load_local_env()

    from app.db.database import SessionLocal
    from app.db.models import Note
    from app.services.note_service import note_service

    db = SessionLocal()
    try:
        rows = _pending_query(db, Note).all()
    finally:
        db.close()

    embeddable = [r for r in rows if _has_text(note_service, r.title, r.content)]
    empty = len(rows) - len(embeddable)

    print(f"pending thought-notes without an embedding: {len(embeddable)}")
    if empty:
        print(f"  ({empty} skipped — no title or body text to embed)")

    if args.dry_run:
        print("dry run — nothing called, nothing written")
        return 0

    if not embeddable:
        print("nothing to do")
        return 0

    if not args.all and args.limit is None:
        print(
            "\nrefusing to guess a batch size. Pass --limit N (each row is one "
            "paid embedding call) or --all.",
            file=sys.stderr,
        )
        return 1

    batch = embeddable if args.all else embeddable[: args.limit]
    print(f"embedding {len(batch)} of {len(embeddable)}...")

    done = 0
    failed: list[int] = []
    for i, row in enumerate(batch):
        # `update_embedding` opens its own session, commits, and swallows its
        # own errors — so success is confirmed by reading the row back, not by
        # the call returning. That is the same trap this backfill exists to
        # clean up after; a "wrote 40 rows" report that wrote none would be a
        # second instance of it.
        try:
            note_service.update_embedding(row.id)
        except Exception as e:  # noqa: BLE001 — one bad row must not end the run
            print(f"  note {row.id}: {type(e).__name__}: {e}", file=sys.stderr)
            failed.append(row.id)
            continue

        check = SessionLocal()
        try:
            stored = (
                check.query(Note.embedding).filter(Note.id == row.id).first()
            )
        finally:
            check.close()
        if stored and stored[0]:
            done += 1
            if args.verbose:
                print(f"  note {row.id}: ok  {(row.title or '')[:60]}")
        else:
            failed.append(row.id)
            print(f"  note {row.id}: no embedding stored", file=sys.stderr)

        if i + 1 < len(batch):
            time.sleep(SLEEP_BETWEEN)

    remaining = len(embeddable) - done
    print(f"\nembedded {done}, failed {len(failed)}, still pending {remaining}")
    if failed:
        print("failed ids: " + ", ".join(str(i) for i in failed), file=sys.stderr)
        return 2
    if remaining:
        print("re-run to continue (safe — embedded rows are skipped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
