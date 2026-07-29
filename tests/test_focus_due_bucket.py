"""Net for the dashboard's short-term / longer-term split. Pure function — no
DB, no LLM.
Run: python tests/test_focus_due_bucket.py

The two things worth pinning down here are the ones that would silently rot the
dashboard: LOCAL-vs-UTC day math, and the defaulted-due rollforward.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

from app.services import focus_service as fs  # noqa: E402

PT = ZoneInfo("America/Los_Angeles")


def _local(y, m, d, hh=12, mm=0):
    """A tz-aware local 'now', like common.local_now returns."""
    return datetime(y, m, d, hh, mm, tzinfo=PT)


def _utc_naive(dt_aware):
    """Storage convention: naive UTC."""
    return dt_aware.astimezone(timezone.utc).replace(tzinfo=None)


def _eod(y, m, d):
    """Local end-of-day, stored naive-UTC — what parse_due_hint produces."""
    return _utc_naive(datetime(y, m, d, 23, 59, tzinfo=PT))


def test_local_eod_today_is_today_not_tomorrow():
    """The bug this guards: 11:59pm PT stores as 06:59 the NEXT UTC day. Bucket
    on raw UTC dates and every 'today' silently files under 'tomorrow'."""
    now = _local(2026, 7, 29, 12)
    due = _eod(2026, 7, 29)
    assert due.date() != now.date()  # the trap is real: UTC date has rolled
    assert fs._due_bucket(due, False, now) == "today"


def test_tomorrow_and_this_week():
    now = _local(2026, 7, 29, 12)
    assert fs._due_bucket(_eod(2026, 7, 30), False, now) == "tomorrow"
    assert fs._due_bucket(_eod(2026, 8, 2), False, now) == "this_week"


def test_boundary_of_short_term_window():
    now = _local(2026, 7, 29, 12)
    edge = _utc_naive(datetime(2026, 7, 29, 23, 59, tzinfo=PT) + timedelta(days=fs.SHORT_TERM_DAYS))
    assert fs._due_bucket(edge, False, now) == "this_week"
    beyond = _utc_naive(
        datetime(2026, 7, 29, 23, 59, tzinfo=PT) + timedelta(days=fs.SHORT_TERM_DAYS + 1)
    )
    assert fs._due_bucket(beyond, False, now) == "long"


def test_explicit_past_due_is_overdue():
    """You named the deadline and blew it. That's the honest signal."""
    now = _local(2026, 7, 29, 12)
    assert fs._due_bucket(_eod(2026, 7, 27), False, now) == "overdue"


def test_defaulted_past_due_rolls_forward_never_overdue():
    """The whole point of due_is_default. Gooni picked today's EOD because no
    date was given; at 12:01am it must NOT start accusing you of being late on a
    deadline you never set."""
    now = _local(2026, 7, 29, 0, 1)
    stale_default = _eod(2026, 7, 20)
    assert fs._due_bucket(stale_default, True, now) == "today"
    # ...and the same date, explicitly chosen, still reads overdue.
    assert fs._due_bucket(stale_default, False, now) == "overdue"


def test_undated_legacy_row_sits_with_the_slow_stuff():
    now = _local(2026, 7, 29, 12)
    assert fs._due_bucket(None, False, now) == "long"


def test_every_bucket_is_renderable():
    """SHORT_BUCKETS drives the panel's render order — a bucket the splitter can
    emit but the panel doesn't know about would vanish from the UI."""
    now = _local(2026, 7, 29, 12)
    emitted = {
        fs._due_bucket(_eod(2026, 7, 27), False, now),
        fs._due_bucket(_eod(2026, 7, 29), False, now),
        fs._due_bucket(_eod(2026, 7, 30), False, now),
        fs._due_bucket(_eod(2026, 8, 2), False, now),
    }
    assert emitted == set(fs.SHORT_BUCKETS)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")
