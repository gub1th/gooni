"""Attribution net — the timer IS the mechanism.

No LLM, no HTTP: exercises `focus_attribution` against a temp SQLite db (same
harness as test_device_activity / test_browser_intervals).

The load-bearing assertions:

  1. END TO END. A focus session written against a commitment, plus device
     intervals recorded during it, comes back attributed to that commitment,
     with `focused_minutes` accruing per commitment per LOCAL day.
  2. THE WINDOW IS THE WHOLE RULE. Activity outside the session's windows is
     not attributed, activity straddling an edge contributes only its OVERLAP,
     and a second commitment's session takes only its own. No classifier is
     consulted, so nothing about the host or app name can change the answer —
     the same host inside two sessions splits between them by clock alone.
  3. PAUSES ARE NOT FOCUS. A session paused for an hour must not be credited
     with what was on screen during the pause. That is what `segments` buys
     over the day's envelope, and an old entry without them is flagged
     `precise: false` rather than silently reported as exact.
  4. LATE DELIVERY ATTRIBUTES IDENTICALLY. Both sensors buffer and retry, so an
     interval stored long after it was measured must land the same as a prompt
     one. This is the reason attribution is derived at read time instead of
     stamped at ingest, and it is the assertion that would fail if anyone ever
     "optimises" it into the ingest path.
  5. UNOBSERVED IS NOT ZERO. A session no sensor recorded keeps its minutes and
     reports `coverage: 0.0` — an uninstalled extension and a genuinely idle
     browser produce the same number and opposite claims, so the minutes must
     never be derived from what the sensors saw.
  6. ONE ROW PER (COMMITMENT, DAY). The write path APPENDS, so four pomodoros
     on one task on one day are four entries — and the overlap buckets are
     keyed by (promise, day), so four unmerged rows would each report the whole
     day's seconds. The minutes would be right and every sensor number beside
     them multiplied by four.
  7. NO NEW STORAGE. Attribution mints no Trackable, writes no row, and needs
     no migration: it is a read over `focus` entries × the two interval tables.

Usage:
  source venv/bin/activate
  python tests/test_focus_attribution.py
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
    Promise,
    Trackable,
    TrackableEntry,
)
from app.services import focus_attribution  # noqa: E402

# No Settings row, so `local_now` falls back to this — the same default
# `common.local_now` uses.
TZ = ZoneInfo("America/Los_Angeles")

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


def at(day, hour, minute=0):
    """A local wall-clock moment on `day` → the naive UTC the DB stores."""
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=TZ)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def iso(dt):
    """Naive-UTC datetime → the ISO string the frontend writes."""
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


# ── fixtures ─────────────────────────────────────────────────────────────────


def make_promise(db, utterance):
    p = Promise(utterance=utterance, summary=utterance, cadence="once", state="active")
    db.add(p)
    db.flush()
    return p


def focus_trackable(db):
    t = (
        db.query(Trackable)
        .filter(Trackable.name == focus_attribution.FOCUS_TRACKABLE)
        .first()
    )
    if t is None:
        # Exactly what the client's `ensureFocusTrackable` creates.
        t = Trackable(
            name=focus_attribution.FOCUS_TRACKABLE,
            kind="numeric",
            unit="minutes",
            agg="sum",
            source="derived",
            parent_promise_id=None,
        )
        db.add(t)
        db.flush()
    return t


def write_session(db, promise, day, runs, *, minutes=None, segments=True, truncated=False):
    """Write one `focus` entry exactly as `focusTime.ts::writeFocusSession` does.

    `runs` is a list of (start, end) naive-UTC pairs — the day's focus segments.
    `segments=False` writes a PRE-attribution entry (envelope only), which is
    what every row written before this feature looks like.
    """
    total = sum((e - s).total_seconds() for s, e in runs) / 60.0
    doc = {
        "promise_id": promise.id,
        "title": promise.summary,
        "started_at": iso(min(s for s, _ in runs)),
        "ended_at": iso(max(e for _, e in runs)),
    }
    if segments:
        doc["segments"] = [{"start": iso(s), "end": iso(e)} for s, e in runs]
    if truncated:
        doc["truncated"] = True
    e = TrackableEntry(
        trackable_id=focus_trackable(db).id,
        date=day,
        value_numeric=round(minutes if minutes is not None else total, 2),
        value_json=json.dumps(doc),
        source="focus",
    )
    db.add(e)
    db.flush()
    return e


_cid = [0]


def browse(db, host, start, end, *, created_at=None):
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
            # When the row LANDED, as distinct from when it was measured. The
            # buffered sensors make these differ by hours; nothing downstream
            # may read it.
            created_at=created_at or datetime.utcnow(),
        )
    )
    db.flush()


def app_use(db, app, start, end):
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


def by_id(payload, pid):
    for rec in payload["promises"]:
        if rec["promise_id"] == pid:
            return rec
    return None


def secs(layer, name):
    for row in layer["top"]:
        if row["name"] == name:
            return row["seconds"]
    return 0.0


# ── the pure core ────────────────────────────────────────────────────────────


def test_overlap():
    print("\noverlap (pure)")
    d = datetime(2026, 8, 14, 10, 0)
    h = timedelta(hours=1)

    check(focus_attribution.overlap_seconds(d, d + h, d, d + h) == 3600, "identical spans")
    check(focus_attribution.overlap_seconds(d, d + h, d + 2 * h, d + 3 * h) == 0, "disjoint → 0")
    check(
        focus_attribution.overlap_seconds(d, d + h, d + h, d + 2 * h) == 0,
        "touching at a point is not overlap (half-open)",
    )
    check(
        focus_attribution.overlap_seconds(d, d + h, d - h, d + timedelta(minutes=30)) == 1800,
        "a straddling span contributes only its overlap",
    )
    check(
        focus_attribution.overlap_seconds(d, d + 3 * h, d + h, d + 2 * h) == 3600,
        "a contained span contributes all of itself",
    )


def test_parse_entry():
    print("\nentry parsing (pure)")
    day = datetime(2026, 8, 14).date()
    w0, w1 = datetime(2026, 8, 14, 17, 0), datetime(2026, 8, 14, 17, 25)

    ent = focus_attribution.parse_focus_entry(
        day,
        25.0,
        json.dumps(
            {
                "promise_id": 7,
                "title": "leetcode",
                "started_at": iso(w0),
                "ended_at": iso(w1),
                "segments": [{"start": iso(w0), "end": iso(w1)}],
            }
        ),
    )
    check(ent is not None and ent.promise_id == 7 and ent.precise, "segments → precise")
    check(ent.minutes == 25.0, "minutes come off value_numeric, not the windows")

    envelope = focus_attribution.parse_focus_entry(
        day,
        25.0,
        json.dumps({"promise_id": 7, "started_at": iso(w0), "ended_at": iso(w1)}),
    )
    check(
        envelope is not None and not envelope.precise,
        "a pre-segments entry still attributes, flagged imprecise",
    )
    check(
        envelope.minutes == 25.0,
        "…and keeps the timer's minutes even though its window is wider",
    )

    check(
        focus_attribution.parse_focus_entry(day, 25.0, json.dumps({"title": "x"})) is None,
        "no promise_id → not attributable",
    )
    check(
        focus_attribution.parse_focus_entry(day, 5.0, "{not json") is None,
        "malformed value_json costs that entry, not the read",
    )
    check(
        focus_attribution.parse_focus_entry(
            day, 5.0, json.dumps({"promise_id": True, "started_at": iso(w0), "ended_at": iso(w1)})
        )
        is None,
        "True is not a promise id (bool is an int in Python)",
    )

    over = focus_attribution.parse_focus_entry(
        day,
        5.0,
        json.dumps(
            {
                "promise_id": 7,
                "started_at": iso(w0),
                "ended_at": iso(w1),
                "segments": [
                    {"start": iso(w0 + timedelta(seconds=i)), "end": iso(w0 + timedelta(seconds=i + 1))}
                    for i in range(focus_attribution.MAX_SEGMENTS_PER_ENTRY + 5)
                ],
            }
        ),
    )
    check(
        over is not None and not over.precise,
        "a segment list past the cap is truncated AND demoted to imprecise",
    )
    check(
        len(over.windows) == focus_attribution.MAX_SEGMENTS_PER_ENTRY,
        "…to exactly the cap",
    )


# ── end to end ───────────────────────────────────────────────────────────────


def test_end_to_end(db):
    print("\nend to end — session → device activity → attributed")
    day = datetime(2026, 8, 14).date()
    leet = make_promise(db, "leetcode daily")

    # 10:00–10:30 local, focused on `leetcode daily`.
    write_session(db, leet, day, [(at(day, 10), at(day, 10, 30))])

    browse(db, "leetcode.com", at(day, 10, 2), at(day, 10, 20))  # 18m inside
    browse(db, "news.ycombinator.com", at(day, 10, 20), at(day, 10, 25))  # 5m inside
    browse(db, "youtube.com", at(day, 14), at(day, 14, 40))  # outside — not the session
    app_use(db, "cursor", at(day, 10), at(day, 10, 30))
    db.commit()

    out = focus_attribution.attribute(db, start_day=day, end_day=day)
    rec = by_id(out, leet.id)

    check(rec is not None, "the commitment appears")
    check(rec["focused_minutes"] == 30.0, "focused minutes accrue per commitment per day")
    check(rec["title"] == "leetcode daily", "titled from the live Promise")
    check(rec["precise"], "a segments-carrying session reads exact")
    check(secs(rec["browser"], "leetcode.com") == 18 * 60, "18m on leetcode attributed")
    check(secs(rec["browser"], "news.ycombinator.com") == 5 * 60, "5m of hn attributed too")
    check(
        secs(rec["browser"], "youtube.com") == 0,
        "activity OUTSIDE the window is not attributed — the window is the whole rule",
    )
    check(secs(rec["app"], "cursor") == 30 * 60, "the app layer attributes the same way")
    check(
        rec["days"][0]["browser"]["top"][0]["label"] == "leetcode",
        "hosts carry the shared device label (`leetcode.com` → `leetcode`)",
    )
    check(rec["days"][0]["app"]["coverage"] == 1.0, "a fully-observed window reads coverage 1.0")

    # Nothing was written, and nothing new was defined.
    check(
        db.query(Trackable).count() == 1,
        "attribution mints NO Trackable — the one `focus` definition is all there is",
    )
    check(
        db.query(Trackable).first().parent_promise_id is None,
        "…and it stays unparented: one rollup, attribution on the ENTRY",
    )


def test_two_commitments_share_a_host(db):
    print("\ntwo commitments, one host — split by the clock alone")
    day = datetime(2026, 8, 15).date()
    a = make_promise(db, "ship the attribution PR")
    b = make_promise(db, "review the eval backlog")

    write_session(db, a, day, [(at(day, 9), at(day, 9, 30))])
    write_session(db, b, day, [(at(day, 10), at(day, 10, 30))])
    # ONE continuous hour on github, straddling both sessions and the gap.
    browse(db, "github.com", at(day, 9, 15), at(day, 10, 15))
    db.commit()

    out = focus_attribution.attribute(db, start_day=day, end_day=day)
    ra, rb = by_id(out, a.id), by_id(out, b.id)

    check(secs(ra["browser"], "github.com") == 15 * 60, "first session takes its 15m")
    check(secs(rb["browser"], "github.com") == 15 * 60, "second session takes its 15m")
    check(
        secs(ra["browser"], "github.com") + secs(rb["browser"], "github.com") < 60 * 60,
        "the 30m between sessions belongs to neither — no session, no attribution",
    )
    check(
        ra["browser"]["top"][0]["intervals"] == 1,
        "one interval counts once, not once per window it touches",
    )

    only_a = focus_attribution.attribute(db, start_day=day, end_day=day, promise_id=a.id)
    check(
        [r["promise_id"] for r in only_a["promises"]] == [a.id],
        "promise_id narrows the read to one commitment",
    )


def test_pause_is_not_focus(db):
    print("\npauses — the reason segments exist")
    day = datetime(2026, 8, 16).date()
    p = make_promise(db, "write the docs")

    # Focused 09:00–09:30, paused for lunch, focused again 11:00–11:30.
    runs = [(at(day, 9), at(day, 9, 30)), (at(day, 11), at(day, 11, 30))]
    write_session(db, p, day, runs)
    browse(db, "twitter.com", at(day, 10), at(day, 10, 45))  # the lunch scroll
    db.commit()

    out = focus_attribution.attribute(db, start_day=day, end_day=day)
    rec = by_id(out, p.id)
    check(rec["focused_minutes"] == 60.0, "only the focus runs count toward the minutes")
    check(
        secs(rec["browser"], "twitter.com") == 0,
        "what happened during the PAUSE is not attributed to the commitment",
    )

    # The same day written the OLD way — envelope only, no segments.
    db.query(TrackableEntry).delete()
    write_session(db, p, day, runs, segments=False)
    db.commit()

    old = by_id(focus_attribution.attribute(db, start_day=day, end_day=day), p.id)
    check(not old["precise"], "a pre-segments entry is FLAGGED imprecise, not dropped")
    check(
        secs(old["browser"], "twitter.com") > 0,
        "…because its envelope really does span the pause — the flag is the honesty",
    )
    check(old["focused_minutes"] == 60.0, "its minutes are still the timer's, not the envelope's")


def test_late_delivery(db):
    print("\nlate delivery — why this is derived at READ time")
    day = datetime(2026, 8, 17).date()
    p = make_promise(db, "finish the sensor writeup")
    write_session(db, p, day, [(at(day, 13), at(day, 13, 30))])

    # Measured inside the session; stored eight hours later, after a long
    # offline stretch. Both sensors retain a batch through 5xx/429/404/offline,
    # so this is ordinary rather than exotic.
    browse(
        db,
        "notion.so",
        at(day, 13, 5),
        at(day, 13, 25),
        created_at=at(day, 21, 30),
    )
    db.commit()

    rec = by_id(focus_attribution.attribute(db, start_day=day, end_day=day), p.id)
    check(
        secs(rec["browser"], "notion.so") == 20 * 60,
        "an interval flushed hours late attributes exactly as a prompt one does",
    )


def test_unobserved_is_not_zero(db):
    print("\nunobserved ≠ zero")
    day = datetime(2026, 8, 18).date()
    p = make_promise(db, "read the paper")
    write_session(db, p, day, [(at(day, 15), at(day, 16))])
    db.commit()

    rec = by_id(focus_attribution.attribute(db, start_day=day, end_day=day), p.id)
    check(rec["focused_minutes"] == 60.0, "a session no sensor saw keeps ALL its minutes")
    check(rec["days"][0]["browser"]["coverage"] == 0.0, "coverage says the sensors saw nothing")
    check(rec["days"][0]["browser"]["top"] == [], "…and there is nothing to show")


def test_multi_day_and_deleted_promise(db):
    print("\nacross days, and after the promise is gone")
    d1 = datetime(2026, 8, 19).date()
    d2 = datetime(2026, 8, 20).date()
    p = make_promise(db, "the long project")

    write_session(db, p, d1, [(at(d1, 9), at(d1, 9, 40))])
    write_session(db, p, d2, [(at(d2, 9), at(d2, 9, 20))])
    browse(db, "github.com", at(d1, 9, 10), at(d1, 9, 30))
    browse(db, "github.com", at(d2, 9), at(d2, 9, 20))
    db.commit()

    rec = by_id(focus_attribution.attribute(db, start_day=d1, end_day=d2), p.id)
    check(rec["focused_minutes"] == 60.0, "minutes fold across the range")
    check([d["date"] for d in rec["days"]] == [d2.isoformat(), d1.isoformat()], "days newest-first")
    check(
        [d["focused_minutes"] for d in rec["days"]] == [20.0, 40.0],
        "…each day carrying its own minutes",
    )
    check(secs(rec["browser"], "github.com") == 40 * 60, "and the seconds fold with them")

    pid = p.id
    db.query(Promise).filter(Promise.id == pid).delete()
    db.commit()
    gone = by_id(focus_attribution.attribute(db, start_day=d1, end_day=d2), pid)
    check(gone is not None, "a deleted promise's sessions do not vanish from the record")
    check(not gone["promise_exists"], "…the row says the commitment is gone")
    check(gone["title"] == "the long project", "…and falls back to the title the entry stored")


def test_two_sessions_one_day(db):
    print("\nfour pomodoros on one task, one day → ONE row")
    day = datetime(2026, 8, 22).date()
    p = make_promise(db, "grind leetcode")

    # `writeFocusSession` APPENDS (it must never `replace`), so separate
    # sittings on one task on one day are separate entries.
    write_session(db, p, day, [(at(day, 9), at(day, 9, 25))])
    write_session(db, p, day, [(at(day, 10), at(day, 10, 25))])
    browse(db, "leetcode.com", at(day, 9, 5), at(day, 9, 15))  # 10m in the first
    browse(db, "leetcode.com", at(day, 10, 5), at(day, 10, 20))  # 15m in the second
    db.commit()

    rec = by_id(focus_attribution.attribute(db, start_day=day, end_day=day), p.id)
    check(len(rec["days"]) == 1, "the day appears ONCE, not once per entry")
    check(rec["focused_minutes"] == 50.0, "its minutes are the sum of both sittings")
    check(
        rec["days"][0]["browser"]["observed_sec"] == 25 * 60,
        "and its observed seconds are counted ONCE, not once per entry",
    )
    check(
        secs(rec["browser"], "leetcode.com") == 25 * 60,
        "…the range fold agrees with the day",
    )
    check(
        rec["days"][0]["browser"]["top"][0]["intervals"] == 2,
        "two separate visits count as two",
    )

    # One imprecise sitting makes the whole day's attribution an upper bound.
    write_session(db, p, day, [(at(day, 14), at(day, 14, 30))], segments=False)
    db.commit()
    rec = by_id(focus_attribution.attribute(db, start_day=day, end_day=day), p.id)
    check(not rec["days"][0]["precise"], "one envelope-only sitting degrades the day to imprecise")
    check(rec["focused_minutes"] == 80.0, "…while its minutes still add normally")


def test_range_guards(db):
    print("\nrange guards")
    day = datetime(2026, 8, 21).date()
    check(
        focus_attribution.attribute(db, start_day=day, end_day=day - timedelta(days=1))["promises"]
        == [],
        "a backwards range is empty, not an error",
    )
    wide = focus_attribution.attribute(
        db, start_day=day - timedelta(days=400), end_day=day
    )
    check(
        wide["start"]
        == (day - timedelta(days=focus_attribution.MAX_DERIVED_DAYS - 1)).isoformat(),
        "an over-wide range is trimmed to MAX_DERIVED_DAYS",
    )
    check(bool(wide["warnings"]), "…and SAYS it was trimmed — no silent caps")


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    test_overlap()
    test_parse_entry()
    test_end_to_end(db)
    test_two_commitments_share_a_host(db)
    test_pause_is_not_focus(db)
    test_late_delivery(db)
    test_unobserved_is_not_zero(db)
    test_multi_day_and_deleted_promise(db)
    test_two_sessions_one_day(db)
    test_range_guards(db)

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — focus attribution (timer-bound, read-time, no new storage)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
