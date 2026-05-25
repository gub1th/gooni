"""One-shot backfill of the cut table from Daniel's whiteboard ("The Cut").

Loads the historical fitness log (Apr 17 – May 22 2026) into DailyMetric
rows via the idempotent `PUT /metrics/cell` endpoint. Because that endpoint
collapses each (date, metric_type) to a single canonical row, re-running this
script is safe — it overwrites rather than stacking duplicates.

Targets whatever `GOONI_URL` points at (use the prod Fly URL). Auth mirrors
mcp/server.py: bearer token = sha256(GOONI_AUTH_PASSWORD).

Usage:
    # dry run (prints what it WOULD send, no writes):
    GOONI_URL=https://<prod> GOONI_AUTH_PASSWORD=<pw> \
        python scripts/backfill_cut_table.py

    # actually write:
    GOONI_URL=https://<prod> GOONI_AUTH_PASSWORD=<pw> \
        python scripts/backfill_cut_table.py --execute
"""

import argparse
import hashlib
import os
import sys

import httpx

# (date, calories, protein, weight_kg, exercise_label, alcohol, note)
# None = leave the cell empty. Transcribed from the whiteboard photo; the
# "Drink ✓" column maps to alcohol=1. Year is 2026.
ROWS: list[tuple] = [
    ("2026-04-17", 2100, 177, None, "pull", None, None),
    ("2026-04-18", 2550, 158, 75.85, "tennis, bike to Lake Merced", 1, None),
    ("2026-04-19", 2095, 197, 75.5, "legs", None, "protein powder is a cheat code; first legs in a while"),
    ("2026-04-20", 2270, 194, 74.3, "push", None, "office food ass"),
    ("2026-04-21", 1840, 204, 75.10, "pull", None, None),
    ("2026-04-22", 2140, 209, 74.95, "legs", None, None),
    ("2026-04-23", 2130, 149, 75.05, "push", None, None),
    ("2026-04-24", 2190, 180, 74.0, None, None, None),
    ("2026-04-25", 2560, 152, 73.65, "pull", 1, None),
    ("2026-04-26", 2000, 202, 73.05, None, None, None),
    ("2026-04-27", 2250, 146, 73.4, "legs", None, None),
    ("2026-04-28", 2100, 201, 73.2, "push", None, None),
    ("2026-04-29", 2210, 163, 73.2, "pull", None, None),
    ("2026-04-30", 2100, 169, 73.8, None, None, None),
    ("2026-05-01", 2175, 179, 73.8, "legs", None, None),
    ("2026-05-02", 2500, None, 73.15, None, None, "Carmel"),
    ("2026-05-03", 2500, None, None, None, None, "Carmel"),
    ("2026-05-04", 2100, 158, 73.8, "pull", None, None),
    ("2026-05-05", 2200, 167, 73.4, "push", None, None),
    ("2026-05-06", 2800, 170, 72.15, "legs", None, None),
    ("2026-05-07", 2180, 165, 72.7, "pull", None, None),
    ("2026-05-08", 2220, 157, 72.55, "push", None, None),
    ("2026-05-09", 3000, 140, 72.3, None, None, None),
    ("2026-05-10", 2220, 130, 72.2, "legs", None, None),
    ("2026-05-11", 2250, 192, 72.2, "pull", None, None),
    ("2026-05-12", 2200, 186, 72.05, "push", None, None),
    ("2026-05-13", 2100, 188, 72.4, None, None, None),
    ("2026-05-14", 2000, 186, 72.7, "legs", None, None),
    ("2026-05-15", 2100, 153, 72.05, "push", None, None),
    ("2026-05-16", 3000, 101, 71.95, "pull", None, "Catherine's birthday"),
    ("2026-05-17", 1750, 150, 71.30, "push", None, None),
    ("2026-05-18", 1800, 150, 71.3, "legs", None, None),
    ("2026-05-19", 2070, 190, 71.05, "pull", None, None),
    ("2026-05-20", 2100, 160, 70.95, "push", None, None),
    ("2026-05-21", 3000, 163, 70.95, None, None, None),
    ("2026-05-22", None, None, 70.95, "legs", None, None),
]


def _cells_for_row(row: tuple) -> list[dict]:
    """Expand one whiteboard row into the non-empty /metrics/cell payloads."""
    date, cal, protein, weight, exercise, alcohol, note = row
    cells: list[dict] = []
    if cal is not None:
        cells.append({"date": date, "metric_type": "calories", "value": cal})
    if protein is not None:
        cells.append({"date": date, "metric_type": "protein", "value": protein})
    if weight is not None:
        cells.append({"date": date, "metric_type": "weight", "value": weight})
    if exercise:
        cells.append({"date": date, "metric_type": "exercise", "text": exercise})
    if alcohol is not None:
        cells.append({"date": date, "metric_type": "alcohol", "value": alcohol})
    if note:
        cells.append({"date": date, "metric_type": "note", "text": note})
    return cells


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--execute", action="store_true", help="actually write (default: dry run)")
    args = ap.parse_args()

    base = os.getenv("GOONI_URL", "http://localhost:8000").rstrip("/")
    pw = os.getenv("GOONI_AUTH_PASSWORD", "").strip()
    headers = {"X-Gooni-Source": "backfill-cut-table"}
    if pw:
        headers["Authorization"] = f"Bearer {hashlib.sha256(pw.encode()).hexdigest()}"

    cells = [c for row in ROWS for c in _cells_for_row(row)]
    print(f"target: {base}  |  rows: {len(ROWS)}  |  cells: {len(cells)}  |  "
          f"{'EXECUTE' if args.execute else 'DRY RUN'}")
    if not args.execute:
        for c in cells:
            print("  would PUT /metrics/cell", c)
        print("\n(dry run — re-run with --execute to write)")
        return 0

    sent = failed = 0
    with httpx.Client(headers=headers, timeout=20) as client:
        for c in cells:
            try:
                r = client.put(f"{base}/metrics/cell", json=c)
                r.raise_for_status()
                sent += 1
            except Exception as e:
                failed += 1
                print(f"  ! {c['date']} {c['metric_type']}: {e}")
    print(f"\ndone — {sent} cells written, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
