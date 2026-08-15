"""Activity-context net — the orchestrator can finally see what Daniel is doing.

No LLM, no HTTP: exercises `activity_context` (and its one write-side dependency,
`focus_cam_service.set_control`'s `control_at` stamp) against a temp SQLite db —
same harness as test_focus_attribution / test_device_activity.

The load-bearing assertions:

  1. THE SUMMARY IS AGGREGATED, NOT RAW. Intervals fold by app / by host with
     durations; the head is ranked and the tail is COUNTED into `+N more` rather
     than dropped. A state block that dumped intervals would blow the budget it
     exists to fit inside.
  2. THE WINDOW CLIPS. An interval straddling the window's edge contributes only
     its overlap — the ordinary case, since intervals close on switches and idle
     rather than on the half hour.
  3. A LIVE SESSION NAMES ITS COMMITMENT. `control: running` + a server-stamped
     `control_at` + a target promise renders the commitment and how long the run
     has been going, so the model has the two facts (what he said he was doing,
     what the sensors saw) side by side.
  4. A STALE CONTROL BLOB IS NOT A SESSION. The focus page's unmount clear never
     runs on a hard tab close, so `control: running` alone is a claim with no
     expiry. An absent stamp, or one older than MAX_RUN, reads as no session.
  5. A RELOAD DOES NOT RESTART THE CLOCK. `useFocusCamControl` re-posts `running`
     on mount, so re-stamping on every post would reset a two-hour run to zero on
     a refresh; a resume (idle → running) DOES start a new run.
  6. SILENCE IS SILENCE. Nothing observed and no session → NO lines at all,
     rather than a section reporting a quiet half-hour nothing witnessed.
  7. UNOBSERVED IS NOT ZERO. A live session no sensor recorded says so — an
     uninstalled extension and a genuinely idle machine are the same rows and
     opposite claims.
  8. IT STATES, IT DOES NOT JUDGE. No score, no percentage of the window called
     productive, no aligned/not-aligned verdict anywhere in the output.
  9. READ-ONLY. The block mints no Trackable and writes no interval — every
     input already existed.
 10. IT REACHES THE PROMPT. `_build_state_block` carries the section.

Usage:
  source venv/bin/activate
  python tests/test_activity_context.py
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
from app.db.models import (  # noqa: E402
    AppInterval,
    Base,
    BrowserInterval,
    Promise,
    Trackable,
)
from app.services import activity_context, focus_cam_service  # noqa: E402
from app.services.activity_context import _trim  # noqa: E402

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


NOW = datetime(2026, 8, 15, 20, 0, 0)


def mins(n):
    return timedelta(minutes=n)


# ── fixtures ─────────────────────────────────────────────────────────────────


_seq = {"n": 0}


def _cid(prefix):
    _seq["n"] += 1
    return f"{prefix}-{_seq['n']}"


def app_interval(db, app, start, end, *, truncated=False, end_reason="app_change"):
    row = AppInterval(
        client_id=_cid("app"),
        app=app,
        started_at=start,
        ended_at=end,
        duration_sec=(end - start).total_seconds(),
        end_reason=end_reason,
        truncated=truncated,
        source="desktop_shell",
    )
    db.add(row)
    db.flush()
    return row


def browser_interval(db, host, start, end, *, title=None, end_reason="tab_change"):
    row = BrowserInterval(
        client_id=_cid("web"),
        host=host,
        path="/",
        url=f"https://{host}/",
        title=title,
        started_at=start,
        ended_at=end,
        duration_sec=(end - start).total_seconds(),
        end_reason=end_reason,
        truncated=False,
        source="chrome_extension",
    )
    db.add(row)
    db.flush()
    return row


def clear_intervals(db):
    db.query(AppInterval).delete()
    db.query(BrowserInterval).delete()
    db.flush()


def clear_focus(db):
    focus_cam_service.set_control(db, "idle")


def joined(lines):
    return "\n".join(lines)


# ── 1 + 2: aggregation and clipping ──────────────────────────────────────────


def test_aggregates_and_clips(db):
    print("\n[aggregation + clipping]")
    clear_intervals(db)
    clear_focus(db)

    # Straddles the window start by 20m — only the 10m inside should count.
    app_interval(db, "cursor", NOW - mins(50), NOW - mins(20))
    app_interval(db, "cursor", NOW - mins(18), NOW - mins(12))
    app_interval(db, "slack", NOW - mins(12), NOW - mins(9))
    browser_interval(
        db, "www.github.com", NOW - mins(9), NOW - mins(3), title="gub1th/gooni — pull requests"
    )
    browser_interval(db, "youtube.com", NOW - mins(3), NOW - mins(1), title="lofi beats")

    s = activity_context.build_activity_summary(db, now=NOW)
    apps = {r["label"]: r["seconds"] for r in s["apps"]["top"]}
    web = {r["label"]: r["seconds"] for r in s["browser"]["top"]}

    check(apps.get("cursor") == 16 * 60, "cursor folds to its in-window seconds only (16m)")
    check(apps.get("slack") == 3 * 60, "slack folds to 3m")
    check(web.get("github") == 6 * 60, "host label drops www./TLD → github, 6m")
    check(web.get("youtube") == 2 * 60, "youtube 2m")

    lines = activity_context.render_activity_lines(s)
    text = joined(lines)
    check("apps: cursor 16m · slack 3m" in text, f"apps line reads aggregated: {text!r}")
    check(
        'github 6m ("gub1th/gooni — pull requests")' in text,
        "browser line carries the representative tab title",
    )
    check(
        "sensors observed" in text and "% covered)" in text,
        "coverage is stated as a fact about the SENSORS",
    )
    check(
        not any(w in text.lower() for w in ("productive", "aligned", "distracted", "score")),
        "no judgement words anywhere in the rendered block",
    )
    check(len(lines) <= 8, f"bounded: {len(lines)} lines")


def test_tail_is_counted_not_dropped(db):
    print("\n[the tail is counted]")
    clear_intervals(db)
    clear_focus(db)

    # Nine hosts, descending — five get named, four must be reported as a tail.
    for i in range(9):
        start = NOW - mins(28 - i * 3)
        browser_interval(db, f"h{i}.com", start, start + mins(2), title=f"t{i}")

    s = activity_context.build_activity_summary(db, now=NOW)
    check(len(s["browser"]["top"]) == activity_context.TOP_HOSTS, "head capped at TOP_HOSTS")
    check(s["browser"]["other_count"] == 4, "the four unnamed hosts are counted")
    check(s["browser"]["other_seconds"] == 8 * 60, "their seconds are carried, not lost")
    text = joined(activity_context.render_activity_lines(s))
    check("+4 more (8m)" in text, f"tail rendered rather than silently cut: {text!r}")

    # And the window total still accounts for every host.
    check(s["observed_seconds"] == 18 * 60, "observed total covers head AND tail")


def test_coverage_counts_overlap_once(db):
    print("\n[the two layers watch one clock]")
    clear_intervals(db)
    clear_focus(db)
    # Chrome frontmost for 10m while a tab held focus for the same 10m. That is
    # ten observed minutes reported by two sensors, not twenty.
    app_interval(db, "google chrome", NOW - mins(20), NOW - mins(10))
    browser_interval(db, "youtube.com", NOW - mins(20), NOW - mins(10), title="lofi")

    s = activity_context.build_activity_summary(db, now=NOW)
    check(s["apps"]["observed_seconds"] == 10 * 60, "the app layer saw 10m")
    check(s["browser"]["observed_seconds"] == 10 * 60, "the browser layer saw the same 10m")
    check(
        s["observed_seconds"] == 10 * 60,
        f"coverage counts the overlap ONCE, got {s['observed_seconds']}s",
    )
    check(round(s["coverage"], 4) == round(1 / 3, 4), "…so coverage is 10/30, not 20/30")

    # Partial overlap merges rather than either summing or dropping a span.
    clear_intervals(db)
    app_interval(db, "google chrome", NOW - mins(20), NOW - mins(10))
    browser_interval(db, "youtube.com", NOW - mins(15), NOW - mins(5), title="lofi")
    s = activity_context.build_activity_summary(db, now=NOW)
    check(s["observed_seconds"] == 15 * 60, "partial overlap unions to 15m")


def test_sub_threshold_names_land_in_the_tail(db):
    print("\n[slivers don't earn a slot]")
    clear_intervals(db)
    clear_focus(db)
    app_interval(db, "cursor", NOW - mins(20), NOW - mins(2))
    app_interval(db, "finder", NOW - mins(2), NOW - mins(2) + timedelta(seconds=5))

    s = activity_context.build_activity_summary(db, now=NOW)
    labels = [r["label"] for r in s["apps"]["top"]]
    check(labels == ["cursor"], f"a 5s alt-tab isn't a thing you were doing: {labels}")
    check(s["apps"]["other_count"] == 1, "it lands in the tail")
    check(s["observed_seconds"] == 18 * 60 + 5, "…and its seconds still count")


# ── 3 + 4 + 5: the live focus session ────────────────────────────────────────


def test_live_session_names_its_commitment(db):
    print("\n[a live session names its commitment]")
    clear_intervals(db)
    p = Promise(
        utterance="ship the attribution PR",
        summary="ship the attribution PR",
        cadence="once",
        state="active",
    )
    db.add(p)
    db.flush()

    focus_cam_service.set_control(db, "running", target_reminder_id=p.id)
    # Server-stamped at "now"; rewind it so the run reads as 23 minutes old.
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = (NOW - mins(23)).isoformat()
    focus_cam_service._write_blob(db, blob)

    app_interval(db, "cursor", NOW - mins(20), NOW - mins(2))

    s = activity_context.build_activity_summary(db, now=NOW)
    focus = s["focus"]
    check(focus is not None, "the running control blob surfaces as a live session")
    check(focus["promise_id"] == p.id, "bound to the target commitment")
    check(focus["title"] == "ship the attribution PR", "carries the commitment's text")
    check(round(focus["elapsed_seconds"]) == 23 * 60, "elapsed = the CURRENT run")

    text = joined(activity_context.render_activity_lines(s))
    check(
        'focus session on "ship the attribution PR" — this run started 23m ago' in text,
        f"rendered with the commitment + run age: {text!r}",
    )
    check("cursor 18m" in text, "the observed activity sits beside it, unjudged")

    clear_focus(db)
    db.query(Promise).delete()
    db.flush()


def test_stale_control_is_not_a_session(db):
    print("\n[a stale control blob is not a session]")
    clear_intervals(db)

    # (a) running with no stamp at all — a blob written before control_at existed.
    focus_cam_service.set_control(db, "running", target_reminder_id=None)
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = None
    focus_cam_service._write_blob(db, blob)
    check(
        activity_context.live_focus_session(db, NOW) is None,
        "an unstamped running blob is refused rather than claimed with unknown age",
    )

    # (b) running, stamped, but older than the client's own 6h run cap.
    blob["control_at"] = (NOW - timedelta(hours=9)).isoformat()
    focus_cam_service._write_blob(db, blob)
    check(
        activity_context.live_focus_session(db, NOW) is None,
        "a 9h-old run is a tab that was closed, not a session",
    )

    # (c) inside the cap → claimed.
    blob["control_at"] = (NOW - timedelta(hours=2)).isoformat()
    focus_cam_service._write_blob(db, blob)
    live = activity_context.live_focus_session(db, NOW)
    check(live is not None, "a 2h run is still a run")
    check(
        live and live["promise_id"] is None and live["title"] == "",
        "an untargeted block reports as one rather than inventing a target",
    )
    text = joined(activity_context.render_activity_lines(
        activity_context.build_activity_summary(db, now=NOW)
    ))
    check("focus session with no target commitment" in text, f"phrased honestly: {text!r}")

    clear_focus(db)
    check(
        activity_context.live_focus_session(db, NOW) is None,
        "stopping clears the session AND its stamp",
    )


def test_reload_does_not_restart_the_run_clock(db):
    print("\n[a reload doesn't restart the clock]")
    clear_focus(db)
    focus_cam_service.set_control(db, "running", target_reminder_id=7)
    first = focus_cam_service.get_blob(db)["control_at"]
    check(bool(first), "starting a run stamps control_at")

    # `useFocusCamControl` fires on mount — a refresh re-posts the same pair.
    focus_cam_service.set_control(db, "running", target_reminder_id=7)
    check(
        focus_cam_service.get_blob(db)["control_at"] == first,
        "an identical re-post keeps the original stamp",
    )

    # A pause (idle) and resume IS a new run.
    focus_cam_service.set_control(db, "idle")
    check(focus_cam_service.get_blob(db)["control_at"] is None, "pausing clears the stamp")
    focus_cam_service.set_control(db, "running", target_reminder_id=7)
    check(
        focus_cam_service.get_blob(db)["control_at"] != first,
        "resuming starts a new run",
    )

    # Switching task re-stamps too — a different commitment is a different run.
    second = focus_cam_service.get_blob(db)["control_at"]
    focus_cam_service.set_control(db, "running", target_reminder_id=8)
    check(
        focus_cam_service.get_blob(db)["control_at"] != second
        and focus_cam_service.get_blob(db)["target_reminder_id"] == 8,
        "switching the target starts a new run",
    )
    clear_focus(db)


# ── 6 + 7: silence, and unobserved-is-not-zero ───────────────────────────────


def test_silence_says_nothing(db):
    print("\n[silence is silence]")
    clear_intervals(db)
    clear_focus(db)
    lines = activity_context.build_activity_context_lines(db)
    check(lines == [], f"no rows + no session → NO section at all, got {lines!r}")


def test_unobserved_session_is_not_zero(db):
    print("\n[unobserved is not zero]")
    clear_intervals(db)
    focus_cam_service.set_control(db, "running", target_reminder_id=None)
    # The stamp is "now" per the server clock, so read against that clock.
    s = activity_context.build_activity_summary(db, now=datetime.utcnow())
    text = joined(activity_context.render_activity_lines(s))
    check(s["focus"] is not None, "the session is still reported")
    check(
        "no device activity recorded in this window" in text,
        f"…and the sensor gap is named rather than read as idleness: {text!r}",
    )
    check("0% covered" not in text, "no coverage percentage is asserted over nothing")
    clear_focus(db)


def test_quiet_and_truncated_are_flagged(db):
    print("\n[quiet + salvaged spans]")
    clear_intervals(db)
    clear_focus(db)
    # Last thing observed ended 9m ago, on an idle close, and was salvaged.
    app_interval(
        db,
        "cursor",
        NOW - mins(25),
        NOW - mins(9),
        truncated=True,
        end_reason="idle",
    )
    s = activity_context.build_activity_summary(db, now=NOW)
    text = joined(activity_context.render_activity_lines(s))
    check("nothing observed since 9m ago" in text, f"the quiet gap is stated: {text!r}")
    check("(screen went idle/locked)" in text, "…with the sensor's own reason when it has one")
    check(
        "durations are a floor" in text,
        "a salvaged span is counted AND marked, never presented as a measurement",
    )

    # …and the flag doesn't depend on the salvaged span winning a named slot.
    clear_intervals(db)
    app_interval(db, "cursor", NOW - mins(25), NOW - mins(2))
    app_interval(
        db,
        "preview",
        NOW - mins(28),
        NOW - mins(28) + timedelta(seconds=10),
        truncated=True,
    )
    s = activity_context.build_activity_summary(db, now=NOW)
    check(
        [r["label"] for r in s["apps"]["top"]] == ["cursor"],
        "the salvaged app is in the tail, not the head",
    )
    check(
        "durations are a floor" in joined(activity_context.render_activity_lines(s)),
        "…and is still flagged from there",
    )


# ── 9: read-only ─────────────────────────────────────────────────────────────


def test_worst_case_stays_inside_the_budget(db):
    print("\n[the budget holds at its worst]")
    clear_intervals(db)
    # Every renderable line at once: a live targeted session started inside the
    # window, both layers saturated with long-titled names past their caps, a
    # salvaged span and a quiet tail.
    p = Promise(
        utterance="x" * 200,
        summary="y" * 200,
        cadence="once",
        state="active",
    )
    db.add(p)
    db.flush()
    focus_cam_service.set_control(db, "running", target_reminder_id=p.id)
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = (NOW - mins(9)).isoformat()
    focus_cam_service._write_blob(db, blob)

    for i in range(30):
        start = NOW - mins(29 - i)
        app_interval(
            db, f"some quite long application name {i}", start, start + timedelta(seconds=40),
            truncated=(i == 0),
        )
        browser_interval(
            db,
            f"sub{i}.a-fairly-long-hostname-{i}.com",
            start,
            start + timedelta(seconds=40),
            title="a very long window title that goes on and on " * 3,
        )

    lines = activity_context.render_activity_lines(
        activity_context.build_activity_summary(db, now=NOW)
    )
    text = joined(lines)
    check(len(lines) <= 8, f"at most 8 lines, got {len(lines)}")
    # ~4 chars/token — 2000 chars is a comfortable ceiling under the ~500-token
    # budget the state block can afford for this section.
    check(len(text) < 2000, f"under the token budget: {len(text)} chars")
    # 29 names land inside the window on each layer (the 30th starts exactly at
    # `now` and clips to nothing), so 29-4 apps and 29-5 hosts are hidden.
    check(
        "+25 more" in text and "+24 more" in text,
        f"both caps still report what they hide: {text!r}",
    )
    check(
        len(_trim("z" * 500)) <= activity_context._TITLE_MAX + 1,
        "a hostile window title can't spend the whole budget on one row",
    )

    clear_focus(db)
    db.query(Promise).delete()
    clear_intervals(db)
    db.flush()


def test_read_only(db):
    print("\n[read-only]")
    clear_intervals(db)
    clear_focus(db)
    app_interval(db, "cursor", NOW - mins(10), NOW - mins(1))
    browser_interval(db, "leetcode.com", NOW - mins(8), NOW - mins(2), title="Two Sum")
    db.commit()

    before_t = db.query(Trackable).count()
    before_a = db.query(AppInterval).count()
    before_b = db.query(BrowserInterval).count()
    activity_context.build_activity_context_lines(db)
    check(db.query(Trackable).count() == before_t, "mints no Trackable")
    check(db.query(AppInterval).count() == before_a, "writes no app interval")
    check(db.query(BrowserInterval).count() == before_b, "writes no browser interval")


# ── 10: it reaches the prompt ────────────────────────────────────────────────


def test_reaches_the_state_block(db):
    print("\n[it reaches the orchestrator's prompt]")
    clear_intervals(db)
    clear_focus(db)
    now = datetime.utcnow()
    app_interval(db, "cursor", now - mins(12), now - mins(1))
    browser_interval(db, "github.com", now - mins(6), now - mins(2), title="gooni PRs")
    db.commit()

    from app.services.orchestrator.prompt_blocks import _build_state_block

    block = _build_state_block(db)
    check(
        f"[doing — last {activity_context.WINDOW_MINUTES}m, from device sensors]" in block,
        "the state block carries the device-activity section",
    )
    check("cursor 11m" in block, f"…with the folded app durations: {block!r}")
    check("github 4m" in block, "…and the folded host durations")
    check("[your state right now]" in block, "existing state-block framing is unchanged")


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    test_aggregates_and_clips(db)
    test_tail_is_counted_not_dropped(db)
    test_coverage_counts_overlap_once(db)
    test_sub_threshold_names_land_in_the_tail(db)
    test_live_session_names_its_commitment(db)
    test_stale_control_is_not_a_session(db)
    test_reload_does_not_restart_the_run_clock(db)
    test_silence_says_nothing(db)
    test_unobserved_session_is_not_zero(db)
    test_quiet_and_truncated_are_flagged(db)
    test_worst_case_stays_inside_the_budget(db)
    test_read_only(db)
    test_reaches_the_state_block(db)

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — activity context (bounded, read-only, states without judging)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
