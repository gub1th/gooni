"""Device-row net — the `opened X` gap rule, both sensor layers, one vocabulary.

No LLM, no HTTP: exercises device_activity + app_activity_service +
activity_service against a temp SQLite db (same harness as
test_browser_intervals).

The load-bearing assertions:

  1. THE GAP RULE. A row saying "opened" must mean opened, not touched. Rapid
     switching between two names emits ONE row per name, not one per switch;
     a return after OPEN_GAP emits a second. If this regresses, an ordinary day
     puts hundreds of rows in the log and the log stops being read.
  2. THE DAY WINDOW. Opens are derived over whole LOCAL calendar days, never
     around the reader's paging cursor, so "what opened on day D" has ONE answer
     however the reader got there. An interval just before a day's start has to
     be visible to the gap rule but must not produce a row, or every local
     midnight manufactures a fake "opened"; a run crossing midnight splits into
     one row per day, each anchored at its own first open.
  3. ONE FEED SHAPE. Browser and app rows come out identical apart from their
     layer, and identical in kind to what the frontend renders for the phone's
     Shortcuts rows.
  4. NO TRACKABLES. Ingesting attention must not mint a Trackable — that is the
     whole reason these rows do not go through POST /events.
  5. THE SCAN CAP COSTS DAYS, NEVER COUNTS. When MAX_SCAN_INTERVALS truncates,
     the day it cut into is dropped WHOLE and the days that survive read exactly
     as an uncapped read of them does. A half-counted day would put (2) back:
     the same day answering differently depending on how wide the read was.

Usage:
  source venv/bin/activate
  python tests/test_device_activity.py
"""

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
from app.db.models import AppInterval, Base, BrowserInterval, Note, Trackable  # noqa: E402
from app.services import activity_service, app_activity_service, device_activity  # noqa: E402

from zoneinfo import ZoneInfo  # noqa: E402

# The db has no Settings row, so local_now falls back to this — the same default
# `common.local_now` uses. Day boundaries below are PT midnights, not UTC ones.
TZ = ZoneInfo("America/Los_Angeles")

T0 = datetime(2026, 8, 12, 17, 0, 0)  # 10:00 PDT

_failures = []


def _day_of(naive_utc):
    """The LOCAL calendar day a stored (naive-UTC) timestamp falls on."""
    return naive_utc.replace(tzinfo=timezone.utc).astimezone(TZ).date()


def _at(day, hour, minute=0):
    """A local wall-clock moment on `day`, as the naive UTC the DB stores."""
    return (
        datetime(day.year, day.month, day.day, hour, minute, tzinfo=TZ)
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )


def check(cond, msg):
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        _failures.append(msg)


def _rows(*specs):
    """(name, start_offset_min, duration_min) → the tuple shape the rule eats."""
    return [
        (i, name, T0 + timedelta(minutes=off), T0 + timedelta(minutes=off + dur))
        for i, (name, off, dur) in enumerate(specs)
    ]


def _app(client_id, *, app="cursor", start=T0, seconds=120, **extra):
    return {
        "client_id": client_id,
        "app": app,
        "started_at": start.isoformat(),
        "ended_at": (start + timedelta(seconds=seconds)).isoformat(),
        **extra,
    }


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    # ── the gap rule, pure ───────────────────────────────────────────────────
    print("\ngap rule")

    # Rapid alt-tabbing: cursor → slack → cursor → slack, seconds apart. Two
    # names touched four times; two rows, because nothing was ever left for
    # long enough to have been re-opened.
    opens = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 2), ("slack", 2, 1), ("cursor", 3, 2), ("slack", 5, 1))
    )
    check(
        [(n, s) for _, n, s in opens] == [
            ("cursor", T0),
            ("slack", T0 + timedelta(minutes=2)),
        ],
        f"rapid switching emits one row per name, not per switch: {[n for _, n, _ in opens]}",
    )

    # Away for longer than the gap = a real return.
    opens = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 2), ("slack", 2, 30), ("cursor", 40, 5))
    )
    check(
        [n for _, n, _ in opens] == ["cursor", "slack", "cursor"],
        f"a return after the gap opens again: {[n for _, n, _ in opens]}",
    )

    # Exactly at the boundary counts as an open (>= gap), one second under
    # does not — the constant means what it says.
    gap_min = int(device_activity.OPEN_GAP.total_seconds() // 60)
    at_gap = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 1), ("cursor", 1 + gap_min, 1))
    )
    under_gap = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 1), ("cursor", gap_min, 1))
    )
    check(len(at_gap) == 2, f"a gap of exactly OPEN_GAP is an open: {at_gap}")
    check(len(under_gap) == 1, f"a gap under OPEN_GAP is not: {under_gap}")

    # `since` filters AFTER the rule ran: the pre-window interval is evidence,
    # not a row. Without this every page of the log grows a fake open at its
    # own leading edge.
    windowed = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 2), ("cursor", 3, 2)), since=T0 + timedelta(minutes=1)
    )
    check(
        windowed == [],
        f"a continuation inside the window is not an open just because the "
        f"evidence sits outside it: {windowed}",
    )

    # A double-reported (or clock-jumped) row must not drag the marker back.
    backwards = device_activity.opens_from_intervals(
        _rows(("cursor", 0, 30), ("cursor", 5, 1), ("cursor", 32, 1))
    )
    check(
        len(backwards) == 1,
        f"an overlapping row can't rewind the last-seen marker: {backwards}",
    )

    # ── clustering: how many ROWS a day of opens is worth ────────────────────
    print("\nclustering")

    # The gap rule alone is not enough, and this is the measured reason: with a
    # dozen names in rotation you genuinely leave each of them for five minutes
    # several times an hour. A simulated workday of 860 intervals across 14
    # hosts and 8 apps yields 408 opens — and 39 rows once they are chained into
    # runs. Here that fact is pinned in miniature.
    hourly = [
        (i, "github.com", T0 + timedelta(minutes=8 * i), T0 + timedelta(minutes=8 * i + 1))
        for i in range(8)  # dipped into every 8 minutes for an hour
    ]
    opens = device_activity.opens_from_intervals(hourly)
    check(len(opens) == 8, f"every one of those IS an open by the gap rule: {len(opens)}")
    runs = device_activity.cluster_opens([(k, n, a) for k, n, a in opens])
    check(
        len(runs) == 1 and runs[0]["count"] == 8,
        f"…and they are ONE row saying so, not eight: {runs}",
    )
    check(
        runs[0]["at"] == opens[0][2] and runs[0]["key"] == opens[0][0],
        "the run is timed (and keyed) at its FIRST open — a row saying 'opened' "
        "belongs at the moment it was opened, and anchoring at the latest put "
        "every all-day name at the end of the day",
    )

    # A name left alone for longer than CLUSTER_GAP starts a new row: coming
    # back after lunch is a different thing from dipping in all morning.
    gap_min = int(device_activity.CLUSTER_GAP.total_seconds() // 60)
    split = device_activity.cluster_opens(
        [("a", "slack", T0), ("b", "slack", T0 + timedelta(minutes=gap_min + 1))]
    )
    check(len(split) == 2, f"a run ends when the name is genuinely dropped: {split}")

    # ── phrasing: one vocabulary across three sensors ────────────────────────
    print("\nvocabulary")
    check(
        device_activity.event_phrase("instagram open") == "opened instagram",
        "a Shortcuts ping reads as a sentence",
    )
    check(device_activity.host_label("www.leetcode.com") == "leetcode", "www + tld stripped")
    check(
        device_activity.host_label("mail.google.com") == "mail.google",
        "a subdomain survives",
    )
    check(
        device_activity.host_label("gooni-bot.fly.dev") == "gooni-bot.fly",
        "a hyphenated host survives",
    )
    check(
        device_activity.host_label("internal.corp.lan") == "internal.corp.lan",
        "an unknown tld is left entirely alone rather than guessed at",
    )

    # ── ingest + derivation over real rows ───────────────────────────────────
    print("\nend to end")

    r = app_activity_service.ingest_batch(
        db,
        [
            _app("a1", app="Cursor", start=T0, seconds=120),
            _app("a2", app="Slack", start=T0 + timedelta(minutes=2), seconds=60),
            _app("a3", app="Cursor", start=T0 + timedelta(minutes=3), seconds=120),
            # after a real break
            _app("a4", app="Slack", start=T0 + timedelta(minutes=40), seconds=60),
        ],
    )
    check(r["accepted"] == 4, f"four app intervals stored: {r}")

    replay = app_activity_service.ingest_batch(db, [_app("a1")])
    check(
        replay["accepted"] == 0 and replay["duplicates"] == 1,
        f"a redelivered app interval dedups: {replay}",
    )

    bad = app_activity_service.ingest_batch(
        db,
        [
            _app("bad-app", app="   "),
            _app("bad-span", start=T0, seconds=0),
            _app("bad-long", start=T0, seconds=7 * 3600),
            _app("ok-after-bad", app="Finder", start=T0 + timedelta(minutes=1)),
        ],
    )
    check(
        sorted(x["reason"] for x in bad["rejected"])
        == ["missing_app", "too_long", "too_short"],
        f"malformed rows are rejected with reasons, one row each: {bad['rejected']}",
    )
    check(bad["accepted"] == 1, f"a good row rides alongside rejected ones: {bad}")

    # A sensor that went BLIND says so, and the ingest has to keep the word: the
    # interval is still right (it closed at the last confirmed observation and
    # carries `truncated`), but nulling the reason makes a wedged osascript
    # indistinguishable from a crash salvage. An unknown reason is still nulled —
    # annotation, never grounds to lose the interval.
    reason_day = _day_of(T0) - timedelta(days=15)
    app_activity_service.ingest_batch(
        db,
        [
            _app("blind", app="Keynote", start=_at(reason_day, 11, 0),
                 end_reason="unobserved", truncated=True),
            _app("odd", app="Keynote", start=_at(reason_day, 13, 0),
                 end_reason="who_knows"),
        ],
    )
    day_rows = app_activity_service.list_intervals(db, day=reason_day)
    by_id = {r["client_id"]: r for r in day_rows}
    check(
        by_id.get("blind", {}).get("end_reason") == "unobserved"
        and by_id.get("blind", {}).get("truncated"),
        f"an `unobserved` close survives ingest with its flag — a wedged sensor "
        f"stays distinguishable from a crash salvage: {by_id.get('blind')}",
    )
    check(
        "odd" in by_id and by_id["odd"]["end_reason"] is None,
        f"an unrecognised reason is nulled, not rejected: {by_id.get('odd')}",
    )
    check(
        len(day_rows) == 2,
        f"`day=` filters to that LOCAL calendar day and nothing else: "
        f"{[r['client_id'] for r in day_rows]}",
    )

    db.add_all(
        [
            BrowserInterval(
                client_id="b1", host="leetcode.com", started_at=T0,
                ended_at=T0 + timedelta(minutes=5), duration_sec=300,
                source="chrome_extension",
            ),
            BrowserInterval(
                client_id="b2", host="mail.google.com",
                started_at=T0 + timedelta(minutes=5),
                ended_at=T0 + timedelta(minutes=6), duration_sec=60,
                source="chrome_extension",
            ),
            # straight back to leetcode — a switch, not an opening
            BrowserInterval(
                client_id="b3", host="leetcode.com",
                started_at=T0 + timedelta(minutes=6),
                ended_at=T0 + timedelta(minutes=20), duration_sec=840,
                source="chrome_extension",
            ),
        ]
    )
    db.commit()

    window = device_activity.device_opens(
        db, start_day=_day_of(T0), end_day=_day_of(T0)
    )
    texts = [it["text"] for it in window]
    check(
        sorted(texts) == sorted(
            # slack was opened TWICE (40 minutes apart), and that is one row
            # carrying a count — the same shape the timeline gives a run of
            # Shortcuts pings. See the clustering block below for why.
            ["opened cursor", "opened slack ×2", "opened finder",
             "opened leetcode", "opened mail.google"]
        ),
        f"both layers derive opens in one vocabulary: {texts}",
    )
    check(
        [it["at"] for it in window] == sorted((it["at"] for it in window), reverse=True),
        "device opens come back newest-first",
    )
    check(
        {it["layer"] for it in window} == {"app", "browser"},
        f"rows name their layer: {[it['layer'] for it in window]}",
    )
    # ONE place writes the verb. The timeline renders `×count` itself, so it
    # needs the sentence WITHOUT the count; rebuilding `f"opened {label}"` there
    # is the fork this module exists to prevent.
    check(
        all(it["text"].startswith(it["phrase"]) for it in window)
        and {it["phrase"] for it in window} == {
            "opened cursor", "opened slack", "opened finder",
            "opened leetcode", "opened mail.google",
        },
        f"every row carries the countless phrase the timeline renders: "
        f"{sorted({it['phrase'] for it in window})}",
    )

    # ── no Trackable was harmed ──────────────────────────────────────────────
    print("\nno trackables")
    names = {t.name for t in db.query(Trackable).all()}
    check(
        names == set(),
        f"attention ingest mints NO Trackable — that is the whole reason these "
        f"rows do not go through POST /events: {names}",
    )
    check(
        db.query(AppInterval).count() == 7,
        "app intervals live in their own table",
    )

    # ── the feed ─────────────────────────────────────────────────────────────
    print("\nactivity feed")
    feed = activity_service.build_activity_feed(
        db, before=(T0 + timedelta(hours=2)).replace(tzinfo=timezone.utc), limit=40
    )
    device_rows = [it for it in feed if it["kind"] == "device"]
    todays = [it for it in device_rows if it["at"].astimezone(TZ).date() == _day_of(T0)]
    check(
        len(todays) == 5,
        f"device rows reach the feed: {len(todays)} for today of "
        f"{len(device_rows)} in the page",
    )
    check(
        all(it["text"].startswith("opened ") for it in device_rows),
        f"every device row is a sentence: {[it['text'] for it in device_rows]}",
    )
    check(
        len({it["key"] for it in device_rows}) == len(device_rows),
        "keys are unique (the log sheet dedups on them across pages)",
    )
    check(
        all(it["at"].tzinfo is not None for it in device_rows),
        "timestamps are tz-aware, like every other source in the merge",
    )

    excluded = activity_service.build_activity_feed(
        db,
        before=(T0 + timedelta(hours=2)).replace(tzinfo=timezone.utc),
        limit=40,
        exclude_kinds={"device"},
    )
    check(
        not [it for it in excluded if it["kind"] == "device"],
        "exclude_kinds={'device'} drops them (the pre-reply state block's read)",
    )

    # ── local-day windows ────────────────────────────────────────────────────
    #
    # The whole point of the seam: "what opened on day D" has ONE answer. A run
    # crossing local midnight is two rows, one per day, each anchored at its own
    # first open; an interval just before midnight is evidence, not a row; and a
    # PAST day reads identically however wide a window asked about it.
    print("\nlocal-day windows")

    d1 = _day_of(T0) - timedelta(days=5)   # a quiet, finished day
    d2 = d1 + timedelta(days=1)
    app_activity_service.ingest_batch(
        db,
        [
            # An evening run on d1 that carries on past midnight into d2.
            _app("m1", app="Ableton", start=_at(d1, 22, 0), seconds=600),
            _app("m2", app="Ableton", start=_at(d1, 23, 0), seconds=600),
            _app("m3", app="Ableton", start=_at(d1, 23, 55), seconds=240),
            # 00:01 — three minutes after the last one ended, so a CONTINUATION
            # by the gap rule, not a new opening.
            _app("m4", app="Ableton", start=_at(d2, 0, 1), seconds=600),
            _app("m5", app="Ableton", start=_at(d2, 0, 40), seconds=600),
        ],
    )

    both = device_activity.device_opens(db, start_day=d1, end_day=d2)
    ableton = [it for it in both if it["name"] == "ableton"]
    check(
        [(it["day"], it["count"]) for it in sorted(ableton, key=lambda i: i["at"])]
        == [(d1.isoformat(), 3), (d2.isoformat(), 1)],
        f"a run across midnight is one row per LOCAL day, each with its own "
        f"count: {[(it['day'], it['count'], it['at'].isoformat()) for it in ableton]}",
    )
    check(
        sorted(it["at"] for it in ableton) == [_at(d1, 22, 0), _at(d2, 0, 40)],
        "each day-part anchors at its FIRST open inside that day — and 00:01, "
        "three minutes after 23:59, is a continuation rather than a fake "
        "'opened' manufactured at midnight",
    )
    check(
        len({it["key"] for it in ableton}) == 2,
        f"the two day-parts have distinct, stable keys: {[it['key'] for it in ableton]}",
    )

    # THE property the seam buys: a past day does not depend on the window that
    # asked about it.
    narrow = [it for it in device_activity.device_opens(db, start_day=d1, end_day=d1)]
    wide = [
        it
        for it in device_activity.device_opens(
            db, start_day=d1 - timedelta(days=9), end_day=d2 + timedelta(days=2)
        )
        if it["day"] == d1.isoformat()
    ]
    key = lambda rows: sorted((r["key"], r["text"], r["at"]) for r in rows)  # noqa: E731
    check(
        key(narrow) == key(wide) and narrow,
        f"a past day reads identically however wide the window: "
        f"{len(narrow)} vs {len(wide)}",
    )

    # ── paging over a quiet stretch ──────────────────────────────────────────
    #
    # The feed SELECTS days; it does not define windows. But the paging cursor is
    # still the merged page's OLDEST item, and the other sources can push it back
    # further in one step than the minimum day set covers. Five days away from
    # the machine: nothing recent, the newest note is eight days old, and the
    # device runs sit six days back — in the span between the two. If the day set
    # did not follow that step, those runs would be derived by no page at all.
    print("\npaging over a quiet stretch")

    anchor = T0 - timedelta(days=1)  # the page-1 cursor; everything above is older

    def _note(title, days_back):
        return Note(
            title=title,
            content="…",
            created_at=anchor - timedelta(days=days_back),
            updated_at=anchor - timedelta(days=days_back),
        )

    db.add(_note("a note from the week before", 8))
    db.commit()

    quiet = anchor - timedelta(days=6)
    app_activity_service.ingest_batch(
        db,
        [
            _app("q1", app="Xcode", start=quiet, seconds=600),
            _app("q2", app="Xcode", start=quiet + timedelta(minutes=30), seconds=600),
        ],
    )

    def _paged_device_rows(limit=40, pages=6):
        found: set[str] = set()
        cursor = anchor.replace(tzinfo=timezone.utc)
        for _ in range(pages):
            page = activity_service.build_activity_feed(db, before=cursor, limit=limit)
            if not page:
                break
            found |= {it["text"] for it in page if it["kind"] == "device"}
            nxt = page[-1]["at"]
            if nxt >= cursor:
                break
            cursor = nxt
        return found

    across_the_gap = _paged_device_rows()
    check(
        "opened xcode ×2" in across_the_gap,
        f"a device run older than the minimum day set but newer than the page's "
        f"own oldest item is still reachable — the day set follows the cursor's "
        f"step instead of sitting inside it: {sorted(across_the_gap)}",
    )

    # …and it follows the step only as far as the floor. An ancient note is not
    # a licence to derive opens back to the beginning of time.
    db.add(_note("something from years ago", 900))
    db.commit()
    app_activity_service.ingest_batch(
        db, [_app("q3", app="Preview", start=anchor - timedelta(days=40), seconds=600)]
    )
    beyond = _paged_device_rows()
    check(
        "opened xcode ×2" in beyond and "opened preview" not in beyond,
        f"the window stops at the absolute floor: rows inside it still surface, "
        f"one 40 days back does not: {sorted(beyond)}",
    )

    # ── the scan cap ─────────────────────────────────────────────────────────
    #
    # The forward gap rule reads a WINDOW rather than paging, so a month of days
    # over a dense sensor is tens of thousands of rows per read. The cap bounds
    # that — but a row cap is exactly the kind of thing that reintroduces the
    # fake `opened` at a boundary, because a truncated predecessor is
    # indistinguishable from no predecessor at all.
    print("\nscan cap")

    cap_t0 = T0 - timedelta(days=60)
    filler = [
        _app(f"cap-f{i}", app="Filler", start=cap_t0 + timedelta(minutes=i), seconds=60)
        for i in range(20)
    ]
    # A genuine open, hours after the filler stops.
    filler.append(_app("cap-kept", app="Kept", start=cap_t0 + timedelta(minutes=300), seconds=600))
    app_activity_service.ingest_batch(db, filler)

    cap_window = dict(start_day=_day_of(cap_t0), end_day=_day_of(cap_t0))
    uncapped = {it["text"] for it in device_activity.device_opens(db, **cap_window)}
    check(
        {"opened filler", "opened kept"} <= uncapped,
        f"uncapped, both names open exactly once: {sorted(uncapped)}",
    )

    def _capped(cap, **window):
        real = device_activity.MAX_SCAN_INTERVALS
        device_activity.MAX_SCAN_INTERVALS = cap
        try:
            return device_activity.device_opens(db, **window)
        finally:
            device_activity.MAX_SCAN_INTERVALS = real

    capped = {it["text"] for it in _capped(5, **cap_window)}
    check(
        capped == set(),
        f"a day the scan only HALF read is dropped WHOLE, not reported with a "
        f"re-anchored run and a truncated count — a missing row is a gap the "
        f"reader can see, a half-counted day is a wrong number: {sorted(capped)}",
    )

    # …and the days that DO come back are byte-identical to an uncapped read of
    # them. The cap costs whole days at the old edge; it never changes what a
    # surviving day says. Dense morning on the older day, one evening run on it,
    # and the newer day's own runs: truncating to the newest few rows floors the
    # scan inside the older day's evening, so the older day goes and the newer
    # one — whose own reach-back evidence survived — stays exactly as it was.
    cd1 = _day_of(T0) - timedelta(days=20)
    cd0 = cd1 - timedelta(days=1)
    app_activity_service.ingest_batch(
        db,
        [
            _app(f"cd0-{i}", app="Numbers", start=_at(cd0, 9, i), seconds=60)
            for i in range(12)
        ]
        + [
            _app("cd0-eve", app="Logic", start=_at(cd0, 22, 0), seconds=600),
            _app("cd1-a", app="Photos", start=_at(cd1, 9, 0), seconds=600),
            _app("cd1-b", app="Photos", start=_at(cd1, 9, 30), seconds=600),
        ],
    )

    two_days = dict(start_day=cd0, end_day=cd1)
    full = device_activity.device_opens(db, **two_days)
    row_key = lambda rows: sorted(  # noqa: E731
        (r["key"], r["day"], r["text"], r["at"]) for r in rows
    )
    check(
        {it["text"] for it in full if it["day"] == cd0.isoformat()}
        == {"opened numbers", "opened logic"}
        and {it["text"] for it in full if it["day"] == cd1.isoformat()}
        == {"opened photos ×2"},
        f"uncapped, both days derive: {[(it['day'], it['text']) for it in full]}",
    )

    part = _capped(3, **two_days)
    check(
        not [it for it in part if it["day"] == cd0.isoformat()],
        f"the day the truncation cut INTO is gone entirely: "
        f"{[(it['day'], it['text']) for it in part]}",
    )
    check(
        row_key(part)
        == row_key([it for it in full if it["day"] == cd1.isoformat()]),
        f"and the fully-scanned day is byte-identical to the uncapped read — "
        f"same key, same anchor, same count: {row_key(part)}",
    )

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — device rows (gap rule, both layers, feed shape, no trackables)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
