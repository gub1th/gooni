#!/usr/bin/env python3
"""One-shot purge of junk rows from the `visits` table.

Background
----------
The `visit_logger` middleware (app/main.py) used to count EVERY `GET /public/*`
hit as a visit — including the SPA's own data fetches (`/public/profile`,
`/public/visits/count`, `/public/notes/<id>/comments`, `/public/mcp`). Fetching
`/public/visits/count` to DISPLAY the counter literally logged a visit.

That bug is fixed forward: the middleware now only logs real content-page views
(`/public/notes` index + `/public/notes/<id>` detail) via `_VISIT_PATH_RE`. But
prod still carries the historical junk rows logged under the old rule. This
script removes them.

What it does NOT change
-----------------------
The public counter is COUNT(DISTINCT ip_hash). Junk rows came from the same IPs
that also hit `/public/notes` on the same page load, so their ip_hashes are
already represented by page-view rows. Purging them leaves the DISTINCT-ip count
(the number visitors see) UNCHANGED — it only cleans `total_visits` and the
`top_paths` breakdown in the auth-gated `/visits/summary`. The dry run prints the
before/after distinct-ip count so you can confirm this.

Predicate
---------
Keep a row iff its path matches `^/public/notes(?:/\\d+)?$` (the index list or a
note detail). Everything else is junk. This MUST stay in sync with
`_VISIT_PATH_RE` in app/main.py — duplicated here so the script has no app-boot
side effects (no lifespan, no migrations).

Usage
-----
    # Local / against a pulled snapshot — DATABASE_URL defaults to db/gooni.db
    python -m scripts.purge_junk_visits            # dry run (no writes)
    python -m scripts.purge_junk_visits --execute  # actually delete

    # Against prod (Fly) — script ships with the deploy, run on-box:
    flyctl ssh console -a gooni-bot -C "python -m scripts.purge_junk_visits"
    flyctl ssh console -a gooni-bot -C "python -m scripts.purge_junk_visits --execute"
"""

from __future__ import annotations

import re
import sys
from collections import Counter

from sqlalchemy import func

from app.db.database import SessionLocal
from app.db.models import Visit

# Keep in sync with app/main.py::_VISIT_PATH_RE
_VISIT_PATH_RE = re.compile(r"^/public/notes(?:/\d+)?$")


def _distinct_ips(db) -> int:
    return int(db.query(func.count(func.distinct(Visit.ip_hash))).scalar() or 0)


def main() -> int:
    execute = "--execute" in sys.argv[1:]

    db = SessionLocal()
    try:
        total = db.query(Visit).count()
        if total == 0:
            print("visits table is empty — nothing to do.")
            return 0

        # Pull (id, path) only — never load embeddings or full rows.
        rows = db.query(Visit.id, Visit.path).all()
        junk_ids = [rid for (rid, path) in rows if not _VISIT_PATH_RE.match(path or "")]
        junk_by_path = Counter(
            path for (_rid, path) in rows if not _VISIT_PATH_RE.match(path or "")
        )

        distinct_before = _distinct_ips(db)

        print(f"total visit rows ......... {total}")
        print(f"page-view rows (keep) .... {total - len(junk_ids)}")
        print(f"junk rows (purge) ........ {len(junk_ids)}")
        print(f"distinct ip_hash (now) ... {distinct_before}  <- the public counter")
        if junk_by_path:
            print("\njunk rows by path:")
            for path, n in junk_by_path.most_common():
                print(f"  {n:6d}  {path}")

        if not junk_ids:
            print("\nno junk rows — nothing to purge.")
            return 0

        if not execute:
            print(
                f"\nDRY RUN — would delete {len(junk_ids)} rows. "
                "Re-run with --execute to apply."
            )
            return 0

        # Delete in chunks so a huge IN(...) doesn't blow SQLite's parameter limit.
        deleted = 0
        CHUNK = 500
        for i in range(0, len(junk_ids), CHUNK):
            batch = junk_ids[i : i + CHUNK]
            deleted += (
                db.query(Visit)
                .filter(Visit.id.in_(batch))
                .delete(synchronize_session=False)
            )
        db.commit()

        distinct_after = _distinct_ips(db)
        print(f"\nDELETED {deleted} junk rows.")
        print(
            f"distinct ip_hash: {distinct_before} -> {distinct_after} "
            f"(public counter {'unchanged' if distinct_before == distinct_after else 'CHANGED'})"
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
