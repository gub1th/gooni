"""Browser-attention aggregation net — the extension popup's read.

No LLM, no HTTP: exercises browser_activity_service.summarize against a temp
SQLite db (same harness as test_browser_intervals).

What is actually load-bearing here:

  * **Local days, not UTC days.** Rows are stored naive UTC and the popup shows
    Daniel's calendar. An evening interval in Los Angeles is stamped with the
    NEXT UTC date, so raw date math files half of every evening under tomorrow
    — the same class of bug test_focus_due_bucket exists to catch.
  * **Truncated is counted, and counted twice.** A salvaged interval is real
    attention whose duration is only a floor. Dropping it understates focus;
    showing it silently overstates it. It must be inside the total AND
    separately reported.
  * **Empty is empty.** A day with no rows still has to appear in the series
    (a trend chart with a hole lies about a quiet day) while the totals stay
    at zero sessions — which is how the popup tells "no data" from "0 seconds".

Usage:
  source venv/bin/activate
  python tests/test_browser_summary.py
"""

import os
import sys
import tempfile
from datetime import date, datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, BrowserInterval, Settings  # noqa: E402
from app.services import browser_activity_service as bas  # noqa: E402

# America/Los_Angeles, pinned below. In August that is UTC-7, so local midnight
# is 07:00 UTC and every local evening carries the NEXT UTC date.
TZ = "America/Los_Angeles"


def _row(db, client_id, *, host, start_utc, seconds, truncated=False):
    db.add(
        BrowserInterval(
            client_id=client_id,
            host=host,
            path="/",
            url=f"https://{host}/",
            title=host,
            started_at=start_utc,
            ended_at=start_utc + timedelta(seconds=seconds),
            duration_sec=float(seconds),
            end_reason="truncated" if truncated else "tab_change",
            truncated=truncated,
            source=bas.SOURCE,
        )
    )
    db.commit()


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []

    def check(cond: bool, msg: str):
        if not cond:
            fails.append(msg)

    s = db.query(Settings).first()
    if not s:
        s = Settings()
        db.add(s)
    s.nudge_tz = TZ
    db.commit()

    day = date(2026, 8, 8)          # a Saturday, PDT (UTC-7)
    prev = date(2026, 8, 7)

    # ── empty range reads as empty, not as zero focus ────────────────────────
    empty = bas.summarize(db, start=day, end=day)
    check(empty["totals"]["sessions"] == 0, "empty window should have 0 sessions")
    check(empty["totals"]["total_sec"] == 0, "empty window should have 0 seconds")
    check(empty["hosts"] == [], "empty window should have no hosts")
    check(len(empty["days"]) == 1, f"one-day window should have 1 day: {empty['days']}")

    # ── a single interval ────────────────────────────────────────────────────
    # local 2026-08-08 09:00 PDT → 16:00 UTC
    _row(db, "one", host="leetcode.com", start_utc=datetime(2026, 8, 8, 16, 0), seconds=90)
    one = bas.summarize(db, start=day, end=day)
    check(one["totals"]["sessions"] == 1, f"single interval sessions: {one['totals']}")
    check(one["totals"]["total_sec"] == 90, f"single interval seconds: {one['totals']}")
    check(one["hosts"][0]["host"] == "leetcode.com", f"host row: {one['hosts']}")
    check(one["days"][0]["total_sec"] == 90, f"day bucket: {one['days']}")

    # ── LOCAL day bucketing: a late-evening interval stamped with tomorrow's
    #    UTC date still belongs to today ─────────────────────────────────────
    # local 2026-08-08 23:30 PDT → 2026-08-09 06:30 UTC
    _row(db, "evening", host="leetcode.com",
         start_utc=datetime(2026, 8, 9, 6, 30), seconds=600)
    ev = bas.summarize(db, start=day, end=day)
    check(ev["totals"]["total_sec"] == 690,
          f"evening interval filed under the wrong local day: {ev['totals']}")
    tomorrow = bas.summarize(db, start=date(2026, 8, 9), end=date(2026, 8, 9))
    check(tomorrow["totals"]["sessions"] == 0,
          f"evening interval leaked into the next local day: {tomorrow['totals']}")

    # ── a span crossing midnight is attributed WHOLLY to its start day ───────
    # local 2026-08-07 23:50 PDT (06:50 UTC on the 8th) running 20 minutes, so
    # it ends at 00:10 on the 8th, local.
    _row(db, "midnight", host="news.ycombinator.com",
         start_utc=datetime(2026, 8, 8, 6, 50), seconds=1200)
    span = bas.summarize(db, start=prev, end=day)
    by_date = {d["date"]: d for d in span["days"]}
    check(by_date["2026-08-07"]["total_sec"] == 1200,
          f"midnight span not on its start day: {by_date}")
    check(by_date["2026-08-07"]["sessions"] == 1, f"start-day sessions: {by_date}")
    check(by_date["2026-08-08"]["total_sec"] == 690,
          f"midnight span bled into the end day: {by_date}")

    # ── truncated: inside the total AND reported separately ─────────────────
    _row(db, "salvaged", host="hellointerview.com",
         start_utc=datetime(2026, 8, 8, 18, 0), seconds=300, truncated=True)
    tr = bas.summarize(db, start=day, end=day)
    check(tr["totals"]["total_sec"] == 990,
          f"truncated row dropped from the total: {tr['totals']}")
    check(tr["totals"]["truncated_sec"] == 300,
          f"truncated seconds not reported: {tr['totals']}")
    check(tr["totals"]["truncated_sessions"] == 1,
          f"truncated sessions not reported: {tr['totals']}")
    hi = next(h for h in tr["hosts"] if h["host"] == "hellointerview.com")
    check(hi["truncated_sec"] == 300 and hi["truncated_sessions"] == 1,
          f"per-host truncated figures: {hi}")
    lc = next(h for h in tr["hosts"] if h["host"] == "leetcode.com")
    check(lc["truncated_sec"] == 0 and lc["truncated_sessions"] == 0,
          f"clean host wrongly marked truncated: {lc}")

    # a day whose ONLY rows are truncated still totals honestly
    only = bas.summarize(db, start=date(2026, 8, 10), end=date(2026, 8, 10))
    check(only["totals"]["sessions"] == 0, "sanity: 08-10 should start empty")
    _row(db, "salv2", host="youtube.com",
         start_utc=datetime(2026, 8, 10, 20, 0), seconds=45, truncated=True)
    only = bas.summarize(db, start=date(2026, 8, 10), end=date(2026, 8, 10))
    check(only["totals"]["total_sec"] == 45 == only["totals"]["truncated_sec"],
          f"all-truncated day: {only['totals']}")
    check(only["totals"]["sessions"] == 1 == only["totals"]["truncated_sessions"],
          f"all-truncated day sessions: {only['totals']}")

    # ── a multi-hour total, and host ranking by time ─────────────────────────
    _row(db, "long", host="leetcode.com",
         start_utc=datetime(2026, 8, 8, 20, 0), seconds=2 * 3600 + 15 * 60)  # 2:15:00
    multi = bas.summarize(db, start=day, end=day)
    check(multi["totals"]["total_sec"] == 990 + 8100,
          f"multi-hour total: {multi['totals']}")
    check(multi["hosts"][0]["host"] == "leetcode.com",
          f"hosts not ranked by time: {multi['hosts']}")
    check([h["host"] for h in multi["hosts"]] ==
          sorted((h["host"] for h in multi["hosts"]),
                 key=lambda name: -next(x["total_sec"] for x in multi["hosts"]
                                        if x["host"] == name)),
          f"host order: {multi['hosts']}")
    check(multi["totals"]["hosts"] == len(multi["hosts"]), "host count mismatch")
    # the headline must equal the sum of the rows under it
    check(abs(multi["totals"]["total_sec"]
              - sum(h["total_sec"] for h in multi["hosts"])) < 1e-6,
          "headline total disagrees with the host rows")

    # ── multi-day window: every day present, including the empty ones ────────
    week = bas.summarize(db, start=date(2026, 8, 4), end=date(2026, 8, 10))
    check([d["date"] for d in week["days"]] ==
          [f"2026-08-{n:02d}" for n in range(4, 11)],
          f"day series has holes: {[d['date'] for d in week['days']]}")
    check(all(d["total_sec"] == 0 for d in week["days"][:3]),
          f"quiet days should be zero, not absent: {week['days'][:3]}")
    check(week["totals"]["total_sec"] == 990 + 8100 + 1200 + 45,
          f"week total: {week['totals']}")

    # ── the window is bounded ────────────────────────────────────────────────
    big = bas.summarize(db, start=date(2026, 1, 1), end=date(2026, 8, 10))
    check(len(big["days"]) == bas.MAX_SUMMARY_DAYS,
          f"oversized window not clamped: {len(big['days'])}")
    check(big["end"] == "2026-08-10", f"clamp should keep the end: {big['end']}")

    # reversed range is repaired rather than returning nothing
    rev = bas.summarize(db, start=day, end=prev)
    check(rev["start"] == prev.isoformat() and rev["end"] == day.isoformat(),
          f"reversed range: {rev['start']}..{rev['end']}")

    db.close()
    if fails:
        print("FAIL")
        for f in fails:
            print("  -", f)
        return 1
    print("PASS — browser attention summary (local-day buckets, truncated, empty)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
