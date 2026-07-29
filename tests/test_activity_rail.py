"""Activity-rail rendering net — the ambient-home feed cleanups.

Three deterministic behaviors, no LLM:
  1. `_num` rounds to ONE decimal (a raw Whoop reading must not leak as
     "hrv 92.2238 ms").
  2. Shortcuts device pings render as a sentence ("instagram open" →
     "opened instagram"), mirroring FocusStream.formatEventLabel.
  3. Identical back-to-back feed polls collapse to ONE row (a Whoop/LeetCode
     re-sync that changed nothing shouldn't spam the rail twice).

Usage:
  source venv/bin/activate
  python tests/test_activity_rail.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Trackable, TrackableEntry  # noqa: E402
from app.services import activity_service  # noqa: E402
from app.services.activity_service import _event_phrase, _num  # noqa: E402


def main() -> int:
    fails: list[str] = []

    # ── 1. _num rounds to one decimal ──
    for v, exp in [
        (92.2238, "92.2"), (20.4936, "20.5"), (6.27, "6.3"),
        (70.0, "70"), (44, "44"), (52.0, "52"), (None, ""),
    ]:
        got = _num(v)
        if got != exp:
            fails.append(f"_num({v!r}) = {got!r}, want {exp!r}")

    # ── 2. device-verb phrasing (base + past forms) ──
    for name, exp in [
        ("instagram open", "opened instagram"),
        ("facebook open", "opened facebook"),
        ("office arrive", "arrived at office"),
        ("home leave", "left home"),
        ("front door unlock", "unlocked front door"),
        ("door lock", "locked door"),
        ("weight", "weight"),               # non-event name passes through
        ("iphone charging", "iphone charging"),  # matched but no phrase → unchanged
    ]:
        got = _event_phrase(name)
        if got != exp:
            fails.append(f"_event_phrase({name!r}) = {got!r}, want {exp!r}")

    # ── 3. feed dedup + rounding end-to-end through build_activity_feed ──
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    now = datetime.utcnow()
    day = now.date()

    lc = Trackable(name="leetcode solved", kind="numeric", source="leetcode")
    wh = Trackable(name="whoop hrv", kind="numeric", unit="ms", source="whoop")
    ig = Trackable(name="instagram open", kind="numeric", source="shortcuts")
    db.add_all([lc, wh, ig])
    db.flush()

    # two identical leetcode polls, 90s apart (distinct seconds → distinct groups)
    db.add_all([
        TrackableEntry(trackable_id=lc.id, date=day, value_numeric=312,
                       source="leetcode", created_at=now),
        TrackableEntry(trackable_id=lc.id, date=day, value_numeric=312,
                       source="leetcode", created_at=now - timedelta(seconds=90)),
        TrackableEntry(trackable_id=wh.id, date=day, value_numeric=92.2238,
                       source="whoop", created_at=now),
        TrackableEntry(trackable_id=ig.id, date=day, value_numeric=1,
                       source="shortcuts", created_at=now),
    ])
    db.commit()

    feed = activity_service.build_activity_feed(db, limit=40)
    lc_rows = [r for r in feed if r.get("source") == "leetcode"]
    wh_rows = [r for r in feed if r.get("source") == "whoop"]
    ig_rows = [r for r in feed if r.get("source") == "shortcuts"]

    if len(lc_rows) != 1:
        fails.append(f"leetcode dedup: got {len(lc_rows)} rows, want 1 "
                     f"({[r['text'] for r in lc_rows]})")
    elif "solved 312" not in lc_rows[0]["text"]:
        fails.append(f"leetcode text = {lc_rows[0]['text']!r}")

    if not wh_rows or "hrv 92.2 ms" not in wh_rows[0]["text"]:
        fails.append(f"whoop rounding: {[r['text'] for r in wh_rows]}")
    if any("92.2238" in r["text"] for r in wh_rows):
        fails.append("whoop text still carries the raw 92.2238 float")

    if not ig_rows or ig_rows[0]["text"] != "opened instagram":
        fails.append(f"shortcuts phrase: {[r['text'] for r in ig_rows]}")

    if fails:
        print("FAILS:")
        for f in fails:
            print("  -", f)
        return 1
    print("\n--- all activity-rail cases passed ---")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
