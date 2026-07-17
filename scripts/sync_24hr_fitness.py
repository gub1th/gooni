#!/usr/bin/env python3
"""Manual / debug runner for the 24hr Fitness -> exercise sync.

The real sync runs server-side from the hourly integration-refresh loop
(`app/background.py` -> `app/services/fitness_24hr.py`). This CLI is just a
thin wrapper for one-off runs + debugging -- it opens a DB session and calls
`fitness_24hr.sync_today`, printing the result dict.

Run from the repo root with the venv active (it imports the app):

    python scripts/sync_24hr_fitness.py --dry-run -v      # today, no write
    python scripts/sync_24hr_fitness.py --date 2026-07-16 # backfill a day

Creds come from env (TFHF_USERNAME / TFHF_PASSWORD) -- from the process env
(fly secrets) or the repo `.env` (loaded here for local convenience). Writes
go to whatever DB the app is configured for (DATABASE_PATH); default = local.
Exit 0 = ran; non-zero = error.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import date
from pathlib import Path


def _load_local_env() -> None:
    """Load the repo-root .env into os.environ for local runs (existing env
    always wins). No-op if a KEY is already set (e.g. fly-injected)."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Manual 24hr Fitness -> Gooni exercise sync.")
    ap.add_argument("--date", help="YYYY-MM-DD (default: local today)")
    ap.add_argument("--label", default="gym", help='label to write (default "gym")')
    ap.add_argument("--dry-run", action="store_true", help="skip the write")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    _load_local_env()

    # Import after env load so the app picks up config from .env.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from app.db.database import SessionLocal
    from app.services import fitness_24hr

    day = date.fromisoformat(args.date) if args.date else None
    db = SessionLocal()
    try:
        res = fitness_24hr.sync_today(db, day=day, label=args.label, dry_run=args.dry_run)
    finally:
        db.close()
    print(json.dumps(res, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
