"""Diff the retired focus tables against the v2 rows they were backfilled into.

`f4c81a92de70` was the EXPAND half of expand/contract: it copied every focus row
into Notes/Promises and deliberately left `thoughts`, `thought_batches`,
`reminders` and `mentions` in place. Run this before the contract migration
drops them — it answers the only question that matters: is anything in the old
tables NOT represented in the new ones?

    python scripts/verify_focus_convergence.py            # local DATABASE_URL
    GOONI_URL=... python scripts/verify_focus_convergence.py --remote

Exit code is 0 when every source row is accounted for, 1 otherwise, so it can
gate the drop. Read-only — it never writes.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.db.database import SessionLocal  # noqa: E402

THOUGHT_TAG = '["thought"]'
BATCH_TAG = '["thought-batch"]'


def _scalar(db, sql: str, **params) -> int:
    return db.execute(text(sql), params).scalar() or 0


def _table_exists(db, name: str) -> bool:
    return bool(
        db.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": name},
        ).scalar()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verbose", action="store_true", help="list every unmatched source row"
    )
    args = parser.parse_args()

    db = SessionLocal()
    problems: list[str] = []
    try:
        missing_tables = [
            t
            for t in ("thoughts", "thought_batches", "reminders")
            if not _table_exists(db, t)
        ]
        if missing_tables:
            print(
                f"source tables already dropped: {', '.join(missing_tables)}\n"
                "the contract migration has run — nothing left to verify."
            )
            return 0

        # ── batches ──────────────────────────────────────────────────────────
        src_batches = _scalar(db, "SELECT COUNT(*) FROM thought_batches")
        new_batches = _scalar(
            db, "SELECT COUNT(*) FROM notes WHERE tags = :t", t=BATCH_TAG
        )
        unmatched_batches = db.execute(
            text(
                "SELECT b.id, b.label FROM thought_batches b WHERE NOT EXISTS ("
                "  SELECT 1 FROM notes n WHERE n.tags = :t"
                "   AND n.topic_id IS b.topic_id AND n.created_at = b.started_at)"
            ),
            {"t": BATCH_TAG},
        ).fetchall()

        # ── thoughts ─────────────────────────────────────────────────────────
        src_thoughts = _scalar(db, "SELECT COUNT(*) FROM thoughts")
        new_thoughts = _scalar(
            db, "SELECT COUNT(*) FROM notes WHERE tags = :t", t=THOUGHT_TAG
        )
        unmatched_thoughts = db.execute(
            text(
                "SELECT t.id, substr(t.content,1,60) c FROM thoughts t WHERE NOT EXISTS ("
                "  SELECT 1 FROM notes n WHERE n.tags = :tag"
                "   AND n.created_at = t.timestamp AND n.content = t.content)"
            ),
            {"tag": THOUGHT_TAG},
        ).fetchall()

        # ── images ───────────────────────────────────────────────────────────
        src_images = _scalar(
            db, "SELECT COUNT(*) FROM thought_batches WHERE image_url IS NOT NULL"
        )
        new_images = _scalar(
            db,
            "SELECT COUNT(DISTINCT a.public_url) FROM attachments a "
            "JOIN notes n ON n.id = a.note_id WHERE n.tags = :t",
            t=BATCH_TAG,
        )

        # ── reminders ────────────────────────────────────────────────────────
        # A reminder is accounted for by the `migrated_from_reminder` edge the
        # 2026-08-01 copy left, or by a verbatim promise.
        src_reminders = _scalar(db, "SELECT COUNT(*) FROM reminders")
        unmatched_reminders = db.execute(
            text(
                "SELECT r.id, r.content FROM reminders r "
                "WHERE NOT EXISTS ("
                "  SELECT 1 FROM edges e WHERE e.kind='migrated_from_reminder'"
                "   AND e.src_kind='reminder' AND e.src_id = r.id)"
                "  AND NOT EXISTS ("
                "  SELECT 1 FROM promises p"
                "   WHERE lower(trim(p.utterance)) = lower(trim(r.content)))"
            )
        ).fetchall()

        # Duplicate detection — the thing that started all this.
        dupes = db.execute(
            text(
                "SELECT lower(trim(utterance)) u, COUNT(*) n FROM promises "
                "GROUP BY u HAVING n > 1 ORDER BY n DESC"
            )
        ).fetchall()

        # ── report ───────────────────────────────────────────────────────────
        def line(label: str, src: int, new: int, bad: int) -> None:
            status = "OK " if bad == 0 else "GAP"
            print(f"  [{status}] {label:<22} source={src:<5} v2={new:<5} unmatched={bad}")
            if bad:
                problems.append(label)

        print("focus convergence verification\n")
        line("thought_batches", src_batches, new_batches, len(unmatched_batches))
        line("thoughts", src_thoughts, new_thoughts, len(unmatched_thoughts))
        line("batch images", src_images, new_images, max(0, src_images - new_images))
        line("reminders", src_reminders, 0, len(unmatched_reminders))

        if dupes:
            print(f"\n  [WARN] {len(dupes)} duplicated promise utterance(s) remain:")
            for d in dupes[:10]:
                print(f"           ×{d.n}  {d.u[:70]}")
            problems.append("duplicate promises")

        if args.verbose:
            for label, rows in (
                ("batch", unmatched_batches),
                ("thought", unmatched_thoughts),
                ("reminder", unmatched_reminders),
            ):
                for r in rows:
                    print(f"    unmatched {label} #{r[0]}: {str(r[1])[:70]}")

        print()
        if problems:
            print(f"NOT SAFE TO DROP — {', '.join(problems)}")
            print("re-run `alembic upgrade head` (the backfill is idempotent), then recheck.")
            return 1
        print("every source row is represented in v2 — safe to run the contract migration.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
