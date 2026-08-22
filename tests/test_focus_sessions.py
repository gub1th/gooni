"""Focus session lifecycle + merged-signal score net.

No LLM, no HTTP: exercises `focus_session_service` and
`focus_session_activity` against a temp SQLite db (same harness as
test_focus_attribution / test_device_activity).

The load-bearing assertions:

  1. FULL LIFECYCLE, SERVER-SIDE. start → pause → resume → stop, with the
     segments and `total_paused_ms` telling the same story, and `active()`
     serving the live one so a refresh / sleep / cold launch can restore it.
  2. STOPPING WRITES THE ENTRY, AND ONLY ONCE. The `focus` TrackableEntry is
     the durable record of the minutes and `agg=sum`, so a second stop must not
     add them again. The written `value_json` is the shape
     `focus_attribution.parse_focus_entry` reads — this is the seam that used
     to be the client's, and the whole attribution layer sits on it.
  3. THE 6H CAP SURVIVES THE TAB CLOSING. A run past MAX_RUN_SEC is sealed at
     the cap, FLAGGED `truncated`, and the session is retired on the next
     `active()` read. The client store could only cap while it was open; this
     is the failure the move to the server exists to fix.
  4. A SESSION ACROSS MIDNIGHT WRITES TWO ENTRIES. One per LOCAL calendar day,
     or the daily fold lies about both.
  5. STARTING ENDS THE PREVIOUS SESSION FIRST. One live session, and the
     outgoing one's minutes land before the new one exists.
  6. THE SCORE IS NOT THE TIMER. A session the camera saw as `away` scores low
     even though the timer ran the whole time (the whiteboard bug), a session
     nothing observed scores `None` rather than a flattering number, and a
     phone event inside the window costs the score.
  7. NO CLASSIFIER. Nothing about a host or app NAME changes the score — the
     browser breakdown is reported, never judged.
  8. A DEAD SIDECAR STOPS SCORING. A camera that reported `focused` and then
     went silent must not have that state credited to the rest of the session —
     the last span is bounded by when the sidecar last spoke.
  9. THE WINDOW-ONLY READ IS UNCHANGED. `GET /focus/session-activity` (PR #522)
     gets no score keys — the score is opt-in, reached by handing the module the
     session's runs, so that endpoint's existing consumers see what they always
     did.
 10. NO NEW TRACKABLE. The lifecycle mints the one `focus` rollup and the
     camera's own walled-off rows; the activity read writes nothing at all.
 11. A MANUAL RENAME WINS. `serialize()` normally prefers the linked
     Promise's live text over the session's own snapshot; a human rename must
     override that, survive a pause/resume/stop cycle, and never touch the
     Promise's own text — all without a new column or a migration (the flag
     rides in the same free-form `segments` Text the run list already uses).

Usage:
  source venv/bin/activate
  python tests/test_focus_sessions.py
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

from zoneinfo import ZoneInfo  # noqa: E402

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import (  # noqa: E402
    AppInterval,
    Base,
    BrowserInterval,
    FocusSession,
    Promise,
    Trackable,
    TrackableEntry,
)
from app.services import (  # noqa: E402
    focus_attribution,
    focus_cam_service,
    focus_session_activity,
    focus_session_service,
)

TZ = ZoneInfo("America/Los_Angeles")

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


def at(day, hour, minute=0, second=0):
    """A local wall-clock moment → the naive UTC the DB stores."""
    local = datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=TZ)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def iso(dt):
    return dt.replace(tzinfo=timezone.utc).isoformat()


DAY = datetime(2026, 8, 12).date()


def reset(db):
    """A clean slate between scenarios — these tests share one db file."""
    for model in (FocusSession, TrackableEntry, BrowserInterval, AppInterval):
        db.query(model).delete()
    db.commit()


def focus_entries(db):
    t = db.query(Trackable).filter(Trackable.name == "focus").first()
    if t is None:
        return []
    return (
        db.query(TrackableEntry)
        .filter(TrackableEntry.trackable_id == t.id)
        .order_by(TrackableEntry.date)
        .all()
    )


def make_promise(db, text):
    p = Promise(utterance=text, summary=text, cadence="once", state="active")
    db.add(p)
    db.commit()
    return p


_cid = [0]


def browser(db, host, start, end):
    _cid[0] += 1
    db.add(
        BrowserInterval(
            client_id=f"b{_cid[0]}",
            host=host,
            path="/",
            url=f"https://{host}/",
            started_at=start,
            ended_at=end,
            duration_sec=(end - start).total_seconds(),
        )
    )
    db.commit()


def cam_state(db, state, when):
    """One camera transition, exactly as `merge_state` records it."""
    focus_cam_service.log_state_change(db, session_id="sc", state=state, at=iso(when))


def cam_event(db, kind, when, duration_sec=None):
    focus_cam_service.log_event(
        db, session_id="sc", kind=kind, started_at=iso(when), duration_sec=duration_sec
    )


# ── 1. lifecycle ─────────────────────────────────────────────────────────────


def test_lifecycle(db):
    print("\nlifecycle: start → pause → resume → stop")
    reset(db)
    p = make_promise(db, "system design prep")
    t0 = at(DAY, 9, 0)

    s = focus_session_service.start(db, title="system design prep", promise_id=p.id, now=t0)
    check(s.state == "running", "start → running")
    check(s.run_started_at == t0, "start opens a run at now")

    live = focus_session_service.active(db, now=at(DAY, 9, 10))
    check(live is not None and live.id == s.id, "active() serves the live session")

    focus_session_service.pause(db, s, now=at(DAY, 9, 25))
    db.refresh(s)
    check(s.state == "paused", "pause → paused")
    check(len(focus_session_service.load_segments(s)) == 1, "pause closes the open run")
    check(s.run_started_at is None, "a paused session has no open run")

    # Pausing twice must not mint an empty second run.
    focus_session_service.pause(db, s, now=at(DAY, 9, 30))
    db.refresh(s)
    check(len(focus_session_service.load_segments(s)) == 1, "pause is idempotent")

    focus_session_service.resume(db, s, now=at(DAY, 9, 40))
    db.refresh(s)
    check(s.state == "running", "resume → running")
    check(s.total_paused_ms == 15 * 60_000, "the pause folds into total_paused_ms (15m)")

    focus_session_service.stop(db, s, now=at(DAY, 10, 0))
    db.refresh(s)
    check(s.state == "stopped" and s.ended_at is not None, "stop → stopped, with an end")

    runs = focus_session_service.load_segments(s)
    check(len(runs) == 2, "two runs: 9:00–9:25 and 9:40–10:00")
    total_min = focus_session_service.focused_seconds(runs) / 60
    check(abs(total_min - 45) < 0.01, f"45 focused minutes, not 60 wall-clock (got {total_min:.2f})")

    check(focus_session_service.active(db) is None, "a stopped session is not active")


# ── 2. the write, and only once ──────────────────────────────────────────────


def test_stop_writes_entry_once(db):
    print("\nstop writes ONE focus entry, in the shape attribution reads")
    reset(db)
    p = make_promise(db, "write the deck")
    s = focus_session_service.start(db, title="write the deck", promise_id=p.id, now=at(DAY, 13, 0))
    focus_session_service.stop(db, s, now=at(DAY, 13, 30))

    rows = focus_entries(db)
    check(len(rows) == 1, f"one entry written (got {len(rows)})")
    doc = json.loads(rows[0].value_json)
    check(abs(rows[0].value_numeric - 30) < 0.01, "30 minutes on the entry")
    check(doc["promise_id"] == p.id, "the promise id rides on the entry")
    check(doc.get("session_id") == s.id, "the entry points back at the session row")
    check(len(doc.get("segments") or []) == 1, "the exact run rides as `segments`")
    check(rows[0].source == "focus", "source=focus")

    parsed = focus_attribution.parse_focus_entry(rows[0].date, rows[0].value_numeric, rows[0].value_json)
    check(parsed is not None and parsed.precise, "attribution parses it, and calls it precise")

    # The DEFINITION is one shared sum-agg rollup with no parent promise —
    # binding it to a Promise would grow the log matrix a column per task,
    # which is the whole reason attribution rides on the entry.
    t = db.query(Trackable).filter(Trackable.name == "focus").first()
    check(t.agg == "sum", "the focus definition is sum-agg (the day folds to minutes)")
    check(t.parent_promise_id is None, "…and carries NO parent promise")
    check(t.source == "derived" and t.unit == "minutes", "…with the same source/unit as before")

    # Idempotent: a second stop must not add the minutes to a sum-agg trackable.
    focus_session_service.stop(db, s, now=at(DAY, 14, 0))
    check(len(focus_entries(db)) == 1, "stopping an already-stopped session writes nothing")


# ── 3. the cap outlives the tab ──────────────────────────────────────────────


def test_overnight_cap(db):
    print("\na session left running overnight is capped, flagged, and retired")
    reset(db)
    p = make_promise(db, "left it running")
    s = focus_session_service.start(db, title="left it running", promise_id=p.id, now=at(DAY, 22, 0))

    # Nine hours later — a laptop closed on a running session.
    later = at(DAY, 22, 0) + timedelta(hours=9)
    runs = focus_session_service.sealed_runs(s, later)
    hours = focus_session_service.focused_seconds(runs) / 3600
    check(abs(hours - 6) < 0.01, f"sealed at the 6h cap, not 9 (got {hours:.2f}h)")
    check(runs[0]["truncated"] is True, "the capped run says it is a floor")

    check(focus_session_service.is_stale(s, later), "the session reads as stale")
    check(focus_session_service.active(db, now=later) is None, "active() retires it")
    db.refresh(s)
    check(s.state == "stopped", "…by stopping it")
    check(s.truncated is True, "the session carries the truncated flag")
    rows = focus_entries(db)
    check(len(rows) >= 1, "its minutes were still written")
    check(
        any(json.loads(r.value_json).get("truncated") is True for r in rows),
        "the written entry is flagged truncated too",
    )


# ── 4. midnight ──────────────────────────────────────────────────────────────


def test_across_midnight(db):
    print("\na session across local midnight writes one entry per day")
    reset(db)
    p = make_promise(db, "late night")
    s = focus_session_service.start(db, title="late night", promise_id=p.id, now=at(DAY, 23, 30))
    focus_session_service.stop(db, s, now=at(DAY + timedelta(days=1), 0, 30))

    rows = focus_entries(db)
    check(len(rows) == 2, f"two entries, one per local day (got {len(rows)})")
    days = sorted(r.date for r in rows)
    check(days == [DAY, DAY + timedelta(days=1)], "filed under both local days")
    check(all(abs(r.value_numeric - 30) < 0.02 for r in rows), "30 minutes each side of midnight")


# ── 5. one live session ──────────────────────────────────────────────────────


def test_start_ends_previous(db):
    print("\nstarting a session ends the previous one first")
    reset(db)
    a = make_promise(db, "task a")
    b = make_promise(db, "task b")
    first = focus_session_service.start(db, title="task a", promise_id=a.id, now=at(DAY, 9, 0))
    second = focus_session_service.start(db, title="task b", promise_id=b.id, now=at(DAY, 9, 20))

    db.refresh(first)
    check(first.state == "stopped", "the outgoing session is stopped")
    check(second.state == "running" and second.id != first.id, "the new session runs")
    live = db.query(FocusSession).filter(FocusSession.state.in_(("running", "paused"))).all()
    check(len(live) == 1, "exactly one live session")
    check(len(focus_entries(db)) == 1, "the outgoing session's minutes landed first")

    # Re-starting the SAME task is not a switch — it would zero the clock.
    again = focus_session_service.start(db, title="task b", promise_id=b.id, now=at(DAY, 9, 30))
    check(again.id == second.id, "re-starting the running task returns it untouched")


# ── 6. the score is not the timer ────────────────────────────────────────────


def test_score_is_not_the_timer(db):
    print("\nTHE score: sensors, not timer state")

    # (a) the whiteboard: timer ran the whole hour, camera saw `away` for most.
    reset(db)
    p = make_promise(db, "at the whiteboard")
    s = focus_session_service.start(db, title="at the whiteboard", promise_id=p.id, now=at(DAY, 14, 0))
    cam_state(db, "focused", at(DAY, 14, 0))
    cam_state(db, "away", at(DAY, 14, 10))
    focus_session_service.stop(db, s, now=at(DAY, 15, 0))

    act = focus_session_service.activity(db, s, now=at(DAY, 15, 0))
    check(
        act["focus_score"] is not None and act["focus_score"] <= 20,
        f"an hour mostly `away` scores low, not 91 (got {act['focus_score']})",
    )
    check(abs(act["focused_seconds"] - 3600) < 1, "the TIMER's own seconds are untouched by the score")
    check(act["seconds"]["away"] > act["seconds"]["focused"], "away dominates the fold")
    check(
        any(seg["state"] == "away" for seg in act["timeline_segments"]),
        "the timeline shows the away stretch",
    )

    # (b) nothing observed → no score at all. Not zero, and certainly not 91.
    reset(db)
    p2 = make_promise(db, "camera off")
    s2 = focus_session_service.start(db, title="camera off", promise_id=p2.id, now=at(DAY, 16, 0))
    focus_session_service.stop(db, s2, now=at(DAY, 16, 30))
    act2 = focus_session_service.activity(db, s2, now=at(DAY, 16, 30))
    check(act2["focus_score"] is None, "unobserved scores None, never 0 and never a number")
    check(act2["presence_pct"] is None, "presence is a camera claim; no camera, no claim")
    check(act2["score_basis"] == [], "and it says which sensors it had (none)")
    check(abs(act2["focused_seconds"] - 1800) < 1, "the minutes survive being unobserved")
    check(act2["score_coverage"] == 0.0, "score_coverage says the sensors saw nothing")

    # (c) device activity with no camera: `active`, and it says so.
    reset(db)
    p3 = make_promise(db, "typing, camera off")
    s3 = focus_session_service.start(db, title="typing", promise_id=p3.id, now=at(DAY, 17, 0))
    browser(db, "hellointerview.com", at(DAY, 17, 0), at(DAY, 17, 30))
    focus_session_service.stop(db, s3, now=at(DAY, 17, 30))
    act3 = focus_session_service.activity(db, s3, now=at(DAY, 17, 30))
    check(act3["focus_score"] == 100, "device coverage with no camera reads as working")
    check(act3["score_basis"] == ["device"], "…and names device as the only basis")
    check(act3["presence_pct"] is None, "device activity never fakes camera presence")
    top = act3["browser"]["top"]
    check(top and top[0]["name"] == "hellointerview.com", "the host is reported")
    check(abs(top[0]["seconds"] - 30 * 60) < 5, "with its seconds inside the window")

    # (d) a phone pickup inside the window costs the score.
    reset(db)
    p4 = make_promise(db, "phone in hand")
    s4 = focus_session_service.start(db, title="phone in hand", promise_id=p4.id, now=at(DAY, 18, 0))
    cam_state(db, "focused", at(DAY, 18, 0))
    cam_event(db, "phone", at(DAY, 18, 10), duration_sec=600)
    focus_session_service.stop(db, s4, now=at(DAY, 18, 30))
    act4 = focus_session_service.activity(db, s4, now=at(DAY, 18, 30))
    check(
        act4["focus_score"] is not None and act4["focus_score"] < 100,
        f"a 10m phone event inside a 30m session dents the score (got {act4['focus_score']})",
    )
    check(
        any(e["kind"] == "phone" and e["count"] == 1 for e in act4["camera_events"]),
        "the event is reported with its count",
    )
    check(
        act4["presence_pct"] == 100,
        "…while presence stays 100 — he was AT the desk, on his phone",
    )


def test_dead_sidecar_does_not_keep_scoring(db):
    print("\na camera that stopped looking stops counting")
    reset(db)
    p = make_promise(db, "long stretch")
    s = focus_session_service.start(db, title="long stretch", promise_id=p.id, now=at(DAY, 9, 0))

    # The sidecar reports `focused` and then DIES. `merge_state` is the real
    # ingest path, so this also stamps the blob's `at` — the liveness signal.
    focus_cam_service.merge_state(
        db, session_id="sc", at=iso(at(DAY, 9, 5)), state="focused", score=0.9, app=None
    )
    focus_session_service.stop(db, s, now=at(DAY, 10, 0))
    act = focus_session_service.activity(db, s, now=at(DAY, 10, 0))

    # Without the bound the last state runs to the end of the session and the
    # hour scores 100% focused on the strength of a camera that stopped
    # reporting at 09:05 — the most flattering way this could be wrong.
    check(
        act["seconds"]["focused"] <= 5 * 60 + 1,
        f"a dead sidecar's last state does not extend to session end (got {act['seconds']['focused']}s focused)",
    )
    check(
        act["seconds"]["unobserved"] > 30 * 60,
        "the unwatched remainder reads as unobserved",
    )
    check(
        act["score_coverage"] is not None and act["score_coverage"] < 0.2,
        f"score_coverage says most of it was unwatched (got {act['score_coverage']})",
    )


def test_window_only_read_is_unchanged(db):
    print("\nthe window-only read (GET /focus/session-activity) gains nothing")
    reset(db)
    p = make_promise(db, "unchanged")
    s = focus_session_service.start(db, title="unchanged", promise_id=p.id, now=at(DAY, 12, 0))
    cam_state(db, "focused", at(DAY, 12, 0))
    browser(db, "leetcode.com", at(DAY, 12, 0), at(DAY, 12, 20))
    focus_session_service.stop(db, s, now=at(DAY, 12, 30))

    # No `runs` → the pre-existing payload, byte for byte. `#522`'s consumers
    # (useSessionActivity, the camera indicator, the evidence gallery) read this
    # shape, and adding a score to it would be a behaviour change they never
    # asked for — the score is opt-in on the SESSION routes.
    windowed = focus_session_activity.session_activity(
        db, since=at(DAY, 12, 0), until=at(DAY, 12, 30)
    )
    for key in (
        "focus_score", "presence_pct", "score_basis", "seconds", "score_coverage",
        "timeline_segments", "session_id", "focused_seconds",
    ):
        check(key not in windowed, f"no `{key}` on the window-only read")
    check("coverage" in windowed and "observed_seconds" in windowed, "its own keys are intact")
    check(
        windowed["browser"]["top"][0]["name"] == "leetcode.com",
        "and it still answers with the sensor rollups",
    )

    # The SESSION read is the superset.
    scored = focus_session_service.activity(db, s, now=at(DAY, 12, 30))
    check(scored["focus_score"] is not None, "the session read DOES score")
    check(scored["coverage"] is not None, "…without losing the window read's own keys")


# ── 7. no classifier ─────────────────────────────────────────────────────────


def test_no_classifier(db):
    print("\nno classifier: the host name cannot move the score")
    scores = {}
    for host in ("hellointerview.com", "youtube.com", "leetcode.com"):
        reset(db)
        p = make_promise(db, f"session on {host}")
        s = focus_session_service.start(db, title="work", promise_id=p.id, now=at(DAY, 11, 0))
        cam_state(db, "focused", at(DAY, 11, 0))
        browser(db, host, at(DAY, 11, 0), at(DAY, 11, 30))
        focus_session_service.stop(db, s, now=at(DAY, 11, 30))
        scores[host] = focus_session_service.activity(db, s, now=at(DAY, 11, 30))["focus_score"]
    check(len(set(scores.values())) == 1, f"identical sessions score identically: {scores}")


# ── 8. what it does NOT write ────────────────────────────────────────────────


def test_no_new_storage(db):
    print("\nthe activity read writes nothing")
    reset(db)
    p = make_promise(db, "quiet")
    s = focus_session_service.start(db, title="quiet", promise_id=p.id, now=at(DAY, 8, 0))
    browser(db, "leetcode.com", at(DAY, 8, 0), at(DAY, 8, 20))
    focus_session_service.stop(db, s, now=at(DAY, 8, 30))

    before = {t.name for t in db.query(Trackable).all()}
    entries_before = db.query(TrackableEntry).count()
    focus_session_service.activity(db, s, now=at(DAY, 8, 30))
    after = {t.name for t in db.query(Trackable).all()}
    check(before == after, "no Trackable minted by the read")
    check(db.query(TrackableEntry).count() == entries_before, "no entry written by the read")
    # The only rollup the lifecycle itself mints is the one `focus` definition.
    check("focus" in after, "the one `focus` rollup exists")


# ── 9. rename wins over the linked promise's live text ──────────────────────


def test_rename_wins_over_promise(db):
    print("\na manual rename wins over the linked commitment's live text")
    reset(db)
    p = make_promise(db, "prep interview")
    s = focus_session_service.start(db, title="prep interview", promise_id=p.id, now=at(DAY, 9, 0))

    # Before any rename, `serialize()` still prefers the live Promise text —
    # this is the behaviour the rename must override, not remove.
    check(
        focus_session_service.serialize(db, s)["title"] == "prep interview",
        "unrenamed: the session shows the promise's current text",
    )

    renamed = focus_session_service.set_title(db, s, "mock interview — round 2")
    check(renamed.title == "mock interview — round 2", "the row's own title is updated")
    check(
        focus_session_service.serialize(db, renamed)["title_is_manual"] is True,
        "serialize reports the rename as manual",
    )

    # The commitment's text changes AFTER the rename — the whole point of the
    # captain's call: the session must not silently revert to it.
    p.summary = "prep interview — take 2"
    db.commit()
    check(
        focus_session_service.serialize(db, renamed)["title"] == "mock interview — round 2",
        "the manual rename still wins after the promise text changes",
    )

    # The flag survives a pause/resume/stop cycle — those overwrite `segments`
    # with a fresh run list and must not silently drop it along the way.
    focus_session_service.pause(db, renamed, now=at(DAY, 9, 10))
    check(
        focus_session_service.serialize(db, renamed)["title"] == "mock interview — round 2",
        "the rename survives a pause",
    )
    focus_session_service.resume(db, renamed, now=at(DAY, 9, 12))
    focus_session_service.stop(db, renamed, now=at(DAY, 9, 20))
    check(
        focus_session_service.serialize(db, renamed)["title"] == "mock interview — round 2",
        "the rename survives stop",
    )

    # Renaming the SESSION must never touch the underlying commitment.
    check(p.summary == "prep interview — take 2", "the promise's own text is untouched")


# ── 10. pure helpers ─────────────────────────────────────────────────────────


def test_pure_classify():
    print("\nclassify(): the sensor fold, without a database")
    r0, r1 = datetime(2026, 8, 12, 20, 0), datetime(2026, 8, 12, 21, 0)
    runs = [(r0, r1)]

    atoms = focus_session_activity.classify(
        runs,
        camera_spans=[(r0, datetime(2026, 8, 12, 20, 30), "focused")],
        violation_spans=[],
        device_spans=[],
    )
    totals = focus_session_activity.fold_states(atoms)
    check(totals["focused"] == 1800, "the covered half is focused")
    check(totals["unobserved"] == 1800, "the uncovered half is unobserved, not focused")
    sc = focus_session_activity.score(totals)
    check(sc["focus_score"] == 100, "unobserved time is out of the denominator entirely")
    check(sc["score_coverage"] == 0.5, "…and score_coverage says only half was watched")

    # `away` outranks a phone event at the same instant: you cannot be at the
    # desk on your phone and away from the desk simultaneously.
    atoms2 = focus_session_activity.classify(
        runs,
        camera_spans=[(r0, r1, "away")],
        violation_spans=[(r0, datetime(2026, 8, 12, 20, 10), "phone")],
        device_spans=[],
    )
    check(
        all(a["state"] == "away" for a in atoms2),
        "an `away` camera outranks an overlapping violation event",
    )

    merged = focus_session_activity.merge_atoms(atoms)
    check(len(merged) == 2, "adjacent same-state atoms merge into one segment")
    check(
        sum(m["end"].timestamp() - m["start"].timestamp() for m in merged) == 3600,
        "merging loses no time",
    )


def main():
    print("focus session lifecycle + merged-signal score\n" + "=" * 46)
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    test_pure_classify()
    test_lifecycle(db)
    test_stop_writes_entry_once(db)
    test_overnight_cap(db)
    test_across_midnight(db)
    test_start_ends_previous(db)
    test_score_is_not_the_timer(db)
    test_dead_sidecar_does_not_keep_scoring(db)
    test_window_only_read_is_unchanged(db)
    test_no_classifier(db)
    test_no_new_storage(db)
    test_rename_wins_over_promise(db)

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — focus sessions (server-side lifecycle, sensor-anchored score)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
