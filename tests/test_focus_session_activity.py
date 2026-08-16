"""Session-scoped activity net — the window is the caller's, and every sensor
answers for it.

No LLM, no HTTP: exercises `focus_session_activity` against a temp SQLite db
(same harness as test_focus_attribution / test_device_activity).

The load-bearing assertions:

  1. SCOPE. The three surfaces this replaces answered for a local DAY. A read
     bounded to a session window must EXCLUDE the same-day camera events,
     phone pings and browsing that fell outside it — that is the entire bug
     ("17 signals today" on a twenty-minute session).
  2. OVERLAP, NOT CONTAINMENT. An interval straddling the session's start
     contributes only its overlap. Inherited from `focus_attribution`, and
     asserted here because this read reaches it through a synthetic window
     rather than a written entry.
  3. EVIDENCE IS SESSION-SCOPED AND SHAPED. Frames inside the window come back
     newest-first with a rendered data: URL; frames outside it do not.
  4. GOONI'S OWN TABS ARE NOT ACTIVITY. Same `self_hosts` exclusion the other
     two read surfaces apply — it must not surface as browsing here either.
  5. COVERAGE IS THE UNION. The browser IS one of the apps, so a browser
     interval and an app interval over the same minute are ONE observed
     minute, never two. Anything else can claim more coverage than the window
     is long.
  6. HONEST BOUNDS. An over-wide window is CLAMPED and says so; an inverted
     one is an empty answer, not a crash.
  7. NO NEW STORAGE. The read mints no Trackable and writes no row.

Usage:
  source venv/bin/activate
  python tests/test_focus_session_activity.py
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import (  # noqa: E402
    AppInterval,
    Base,
    BrowserInterval,
    Trackable,
    TrackableEntry,
)
from app.services import focus_session_activity  # noqa: E402

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


# A fixed naive-UTC anchor — every fixture below is an offset from it, so the
# assertions never depend on when the suite runs.
T0 = datetime(2026, 8, 16, 17, 0, 0)


def iso(dt):
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


# ── fixtures ─────────────────────────────────────────────────────────────────

_cid = [0]


def browse(db, host, start, end):
    _cid[0] += 1
    db.add(
        BrowserInterval(
            client_id=f"b-{_cid[0]}",
            host=host,
            path="/",
            url=f"https://{host}/",
            started_at=start,
            ended_at=end,
            duration_sec=(end - start).total_seconds(),
            source="chrome_extension",
        )
    )
    db.flush()


def use_app(db, app, start, end):
    _cid[0] += 1
    db.add(
        AppInterval(
            client_id=f"a-{_cid[0]}",
            app=app,
            started_at=start,
            ended_at=end,
            duration_sec=(end - start).total_seconds(),
            source="desktop_shell",
        )
    )
    db.flush()


def _trackable(db, name, *, kind, source, agg="sum"):
    t = db.query(Trackable).filter(Trackable.name == name).first()
    if t is None:
        t = Trackable(name=name, kind=kind, agg=agg, source=source)
        db.add(t)
        db.flush()
    return t


def cam_event(db, kind, at):
    """One `POST /focus/cam/events` as `focus_cam_service.log_event` stores it."""
    t = _trackable(db, f"focus {kind}", kind="numeric", source="focus_cam")
    db.add(
        TrackableEntry(
            trackable_id=t.id,
            date=at.date(),
            value_numeric=1.0,
            value_json=json.dumps({"at": iso(at), "session_id": "s1"}),
            source="focus_cam",
        )
    )
    db.flush()


def cam_evidence(db, kind, at, b64="AAAA"):
    t = _trackable(db, "focus_evidence", kind="json", source="focus_cam", agg="last")
    db.add(
        TrackableEntry(
            trackable_id=t.id,
            date=at.date(),
            value_json=json.dumps(
                {"kind": kind, "at": iso(at), "session_id": "s1", "jpeg_b64": b64}
            ),
            source="focus_cam",
        )
    )
    db.flush()


def phone_ping(db, name, at):
    """One iOS Shortcuts ping as `event_service.log_event` stores it."""
    t = _trackable(db, name, kind="numeric", source="shortcuts")
    db.add(
        TrackableEntry(
            trackable_id=t.id,
            date=at.date(),
            value_numeric=1.0,
            value_json=json.dumps({"at": iso(at)}),
            source="shortcuts",
        )
    )
    db.flush()


def m(n):
    return timedelta(minutes=n)


# ── tests ────────────────────────────────────────────────────────────────────


def test_scope_is_the_window(db):
    """1 + 3: the same DAY carries events on both sides of the session; only
    the ones inside it come back."""
    print("\ntest_scope_is_the_window")
    session_start, session_end = T0, T0 + m(20)

    # inside
    cam_event(db, "phone", T0 + m(3))
    cam_event(db, "phone", T0 + m(9))
    cam_event(db, "stand", T0 + m(12))
    phone_ping(db, "whatsapp open", T0 + m(5))
    cam_evidence(db, "phone", T0 + m(9), b64="INSIDE")
    browse(db, "hellointerview.com", T0 + m(1), T0 + m(15))

    # same local day, OUTSIDE the session — this is the "17 signals today" bug
    cam_event(db, "phone", T0 - m(90))
    cam_event(db, "vape", T0 + m(120))
    phone_ping(db, "whatsapp open", T0 - m(90))
    phone_ping(db, "whatsapp open", T0 + m(120))
    cam_evidence(db, "vape", T0 + m(120), b64="OUTSIDE")
    browse(db, "youtube.com", T0 + m(60), T0 + m(90))

    r = focus_session_activity.session_activity(
        db, since=session_start, until=session_end
    )

    events = {e["kind"]: e["count"] for e in r["camera_events"]}
    check(events == {"phone": 2, "stand": 1}, f"camera events are session-scoped ({events})")

    device = {d["name"]: d["count"] for d in r["device"]["top"]}
    check(device == {"whatsapp open": 1}, f"phone pings are session-scoped ({device})")
    check(
        r["device"]["top"][0]["label"] == "opened whatsapp",
        "device row speaks the shared `opened X` vocabulary",
    )

    hosts = {b["name"]: b["seconds"] for b in r["browser"]["top"]}
    check(list(hosts) == ["hellointerview.com"], f"browsing is session-scoped ({list(hosts)})")
    check(hosts["hellointerview.com"] == 14 * 60, "browser seconds are the in-window seconds")
    check(
        r["browser"]["top"][0]["label"] == "hellointerview",
        "browser row carries the cosmetic host label",
    )

    ev = r["camera_evidence"]
    check(len(ev) == 1 and ev[0]["kind"] == "phone", f"evidence is session-scoped ({len(ev)})")
    check(
        ev[0]["frame"] == "data:image/jpeg;base64,INSIDE",
        "evidence frame is a ready-to-render data: URL",
    )
    check(ev[0]["at"] == (T0 + m(9)).isoformat(), "evidence carries its own clock time")


def test_overlap_not_containment(db2):
    """2: an interval straddling the start contributes only its overlap."""
    print("\ntest_overlap_not_containment")
    since, until = T0, T0 + m(30)
    # started 20m before the session, ran 10m into it
    browse(db2, "docs.python.org", T0 - m(20), T0 + m(10))
    # ends 15m after the session, started 5m before it ended
    use_app(db2, "cursor", T0 + m(25), T0 + m(45))

    r = focus_session_activity.session_activity(db2, since=since, until=until)
    b = {x["name"]: x["seconds"] for x in r["browser"]["top"]}
    a = {x["name"]: x["seconds"] for x in r["app"]["top"]}
    check(b.get("docs.python.org") == 10 * 60, f"leading straddle clipped ({b})")
    check(a.get("cursor") == 5 * 60, f"trailing straddle clipped ({a})")


def test_self_host_excluded(db2):
    """4: browsing Gooni is using the tool, not activity."""
    print("\ntest_self_host_excluded")
    since, until = T0 + m(300), T0 + m(330)
    browse(db2, "gooni-bot.fly.dev", since, since + m(20))
    browse(db2, "leetcode.com", since, since + m(5))
    r = focus_session_activity.session_activity(db2, since=since, until=until)
    names = [x["name"] for x in r["browser"]["top"]]
    check(names == ["leetcode.com"], f"self-host dropped before the fold ({names})")


def test_coverage_is_the_union(db2):
    """5: one minute seen by both sensors is one observed minute."""
    print("\ntest_coverage_is_the_union")
    since, until = T0 + m(120), T0 + m(130)  # a 10-minute window
    browse(db2, "news.ycombinator.com", since, since + m(10))
    use_app(db2, "google chrome", since, since + m(10))
    r = focus_session_activity.session_activity(db2, since=since, until=until)
    check(
        r["observed_seconds"] == 600.0,
        f"union, not sum ({r['observed_seconds']} — a sum would be 1200)",
    )
    check(r["coverage"] == 1.0, f"coverage never exceeds the window ({r['coverage']})")


def test_bounds(db2):
    """6: an inverted window is empty, an over-wide one is clamped + reported."""
    print("\ntest_bounds")
    inverted = focus_session_activity.session_activity(db2, since=T0, until=T0 - m(5))
    check(inverted["warnings"] == ["empty range"], "inverted range is an empty answer")
    check(inverted["camera_events"] == [], "inverted range carries no rows")

    wide_since = T0 - timedelta(days=10)
    wide = focus_session_activity.session_activity(db2, since=wide_since, until=T0)
    check(
        any("newest 24h" in w for w in wide["warnings"]),
        f"over-wide window says it was clamped ({wide['warnings']})",
    )
    check(
        wide["since"] == (T0 - focus_session_activity.MAX_WINDOW).isoformat(),
        "clamp moves `since` forward, and the response reports the window it used",
    )


def test_no_new_storage(db2):
    """7: a read that mints a Trackable would be a write wearing a read's name."""
    print("\ntest_no_new_storage")
    before_t = db2.query(Trackable).count()
    before_e = db2.query(TrackableEntry).count()
    focus_session_activity.session_activity(db2, since=T0 - m(30), until=T0 + m(30))
    check(db2.query(Trackable).count() == before_t, "no Trackable minted")
    check(db2.query(TrackableEntry).count() == before_e, "no entry written")


def test_quiet_window(db2):
    """A session nothing observed is an empty answer, never an error — and its
    coverage is 0.0, which is a claim about the SENSORS."""
    print("\ntest_quiet_window")
    r = focus_session_activity.session_activity(
        db2, since=T0 + timedelta(days=2), until=T0 + timedelta(days=2, minutes=25)
    )
    check(r["camera_events"] == [] and r["camera_evidence"] == [], "no camera rows")
    check(r["browser"]["top"] == [] and r["app"]["top"] == [], "no interval rows")
    check(r["observed_seconds"] == 0.0 and r["coverage"] == 0.0, "coverage is 0.0, not None")
    check(r["warnings"] == [], "a quiet window is not a warning")


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    test_scope_is_the_window(db)
    test_overlap_not_containment(db)
    test_self_host_excluded(db)
    test_coverage_is_the_union(db)
    test_bounds(db)
    test_no_new_storage(db)
    test_quiet_window(db)

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — session-scoped activity (one window, every sensor, no new storage)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
