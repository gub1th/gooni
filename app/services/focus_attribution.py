"""Attribution — binding observed attention to a declared commitment.

`BrowserInterval` and `AppInterval` both say in their docstrings that they are
"the honest substrate that a later attribution layer reads", and
`device_activity` says it is "deliberately NOT attribution". This module is that
later layer, and it is the whole of it.

**The timer IS the mechanism.** There is no classifier, no embedding, no
keyword list and no heuristic anywhere below. A focus session is a NAMED task
plus a bounded window, so every interval overlapping that window belongs to that
Promise BY CONSTRUCTION. That is the entire design, and it is why the one door
into `/focus` is a task row: attribution is free exactly as long as starting a
session requires naming what it is for.

**Derived at READ time, never stamped at ingest.** This is the load-bearing
decision, and the tempting alternative is wrong by construction rather than
merely worse. Both sensors BUFFER: the extension retains a batch through
`5xx`/`429`/`404`/`401`/offline, and the desktop shell persists its buffer
across quits and relaunches. An interval measured at 14:30 legitimately arrives
at 18:00. Stamping "the session running right now" onto it at ingest would file
that interval against whatever is running at 18:00 — or against nothing —
silently, permanently, and most often on exactly the days the network was bad.
Overlapping durable session windows at read time attributes a late interval
identically to a prompt one, which is the only behaviour that survives the
delivery model the sensors were built around. (It is also the only one
available: session state is a client store, so at ingest the server does not
know a session is running at all.)

**No new table, no new column, no migration.** The two inputs already exist:

  - the session windows: `TrackableEntry` rows of the `focus` trackable, whose
    `value_json` carries `{promise_id, title, started_at, ended_at, segments}`
    (written by `frontend/src/services/focusTime.ts`);
  - the attention: `browser_intervals` + `app_intervals`.

**Precision comes from `segments`, and its absence is REPORTED.** An entry's
`started_at`/`ended_at` are the day's ENVELOPE — `splitSegmentsByDay` folds
every focus run on a day into one entry, so a session paused for lunch has an
envelope that spans the lunch. Overlapping the envelope would credit the
Promise with whatever was on screen while the timer was paused, which is the
"confidently wrong focus percentages" failure the raw tables were kept clean to
avoid. So the write path now also emits `segments` (the exact clipped focus
runs) and this module prefers them; an older entry with no `segments` still
attributes, but its rows are flagged `precise: false` and their seconds are an
UPPER BOUND. Flagged rather than dropped, and flagged rather than silently
mixed: a number that may be too high is useful when it says so and poison when
it doesn't.

**What is deliberately NOT here.** No score, no percentage of a day, no
"productive" judgement, no ranking of one Promise against another. `coverage` is
the closest this gets and it answers a question about the SENSORS ("how much of
this window did anything observe?"), not about the human — a session with the
extension uninstalled must read as unobserved, never as zero minutes of
browsing. Those are the same number and opposite claims.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date as _date
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .device_activity import MAX_DERIVED_DAYS, MAX_SCAN_INTERVALS, host_label
from .interval_ingest import MAX_INTERVAL_SEC, parse_dt

# The one focus rollup's name. Must match `focusTime.ts::FOCUS_TRACKABLE` —
# there is exactly one `focus` trackable and the client get-or-creates it by
# this name, so a rename on either side has to be a rename on both.
FOCUS_TRACKABLE = "focus"

# Most names reported per layer per Promise. A day of browsing touches dozens of
# hosts and the tail is noise; the point of the read is "was I on it", which the
# head answers. Truncation is COUNTED and reported (`other_sec`), never silent.
TOP_N = 10

# Most `segments` parsed out of one entry's value_json.
#
# `value_json` is unindexed free-form Text written by a client, so its length is
# not bounded by anything server-side. A real day of pomodoros is ~16 segments;
# anything past this is a malformed or hostile write, and parsing it would make
# one entry able to dominate a whole read. Excess is dropped from the END and
# the entry is marked imprecise, which is the same honesty rule the envelope
# fallback gets: a partial window list under-attributes, so it must not claim to
# be exact.
MAX_SEGMENTS_PER_ENTRY = 500


# ── the pure core ────────────────────────────────────────────────────────────


def overlap_seconds(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> float:
    """Seconds two half-open [start, end) spans share. 0 when they don't.

    Overlap rather than containment on purpose. A tab held for forty minutes
    across a twelve-minute session contributed twelve minutes to that session,
    not forty and not nothing — and "not nothing" is the case that matters,
    since intervals close on switches and idle, so the interval straddling a
    session's start is the ordinary one rather than the exotic one.
    """
    lo = max(a0, b0)
    hi = min(a1, b1)
    if hi <= lo:
        return 0.0
    return (hi - lo).total_seconds()


@dataclass
class FocusEntry:
    """One written focus session-day: the minutes, and the windows they fell in."""

    promise_id: int
    title: str
    day: _date
    #: The AUTHORITATIVE minutes for this (promise, day) — the timer's own
    #: number, straight off `value_numeric`. Never recomputed from the windows:
    #: an envelope-fallback entry's windows are wider than its minutes by
    #: construction, and recomputing would quietly inflate the one number the
    #: whole feature exists to produce.
    minutes: float
    #: Naive-UTC [start, end) spans the session actually accrued in.
    windows: list[tuple[datetime, datetime]] = field(default_factory=list)
    #: True when `segments` were present, so the windows exclude paused time.
    #: False → the windows are the day's envelope and every attributed second
    #: derived from them is an upper bound.
    precise: bool = True
    #: The session was CAPPED rather than closed by a human (`MAX_RUN_MS`), so
    #: its minutes are a floor. Carried through untouched from the entry.
    truncated: bool = False

    def window_seconds(self) -> float:
        return sum((e - s).total_seconds() for s, e in self.windows)


def parse_focus_entry(day: _date, value_numeric, raw_json) -> FocusEntry | None:
    """One `focus` TrackableEntry → a FocusEntry, or None if it isn't one.

    Defensive throughout: `value_json` is free-form Text, the rows predate this
    module, and a single malformed entry must cost that entry rather than the
    read. An entry with no usable `promise_id` is not attributable and is
    skipped — silently, because that is also the shape of every hand-written
    row in the column.
    """
    if isinstance(raw_json, dict):
        doc = raw_json
    else:
        try:
            doc = json.loads(raw_json) if raw_json else None
        except (TypeError, ValueError):
            return None
    if not isinstance(doc, dict):
        return None

    pid = doc.get("promise_id")
    # `bool` is an `int` in Python and `True` is not a promise id.
    if isinstance(pid, bool) or not isinstance(pid, int):
        return None

    windows: list[tuple[datetime, datetime]] = []
    precise = True
    raw_segments = doc.get("segments")
    if isinstance(raw_segments, list) and raw_segments:
        if len(raw_segments) > MAX_SEGMENTS_PER_ENTRY:
            raw_segments = raw_segments[:MAX_SEGMENTS_PER_ENTRY]
            precise = False
        for seg in raw_segments:
            if not isinstance(seg, dict):
                continue
            s = parse_dt(seg.get("start"))
            e = parse_dt(seg.get("end"))
            if s is None or e is None or e <= s:
                continue
            windows.append((s, e))

    if not windows:
        # No usable segments — fall back to the day's envelope, which spans any
        # pause inside it. Attribution still works; it just can't be exact, and
        # says so.
        s = parse_dt(doc.get("started_at"))
        e = parse_dt(doc.get("ended_at"))
        if s is None or e is None or e <= s:
            return None
        windows = [(s, e)]
        precise = False

    windows.sort()
    try:
        minutes = float(value_numeric) if value_numeric is not None else 0.0
    except (TypeError, ValueError):
        minutes = 0.0

    return FocusEntry(
        promise_id=pid,
        title=str(doc.get("title") or "").strip(),
        day=day,
        minutes=minutes,
        windows=windows,
        precise=precise,
        truncated=doc.get("truncated") is True,
    )


def merge_entries(entries: list[FocusEntry]) -> list[FocusEntry]:
    """Fold every entry for one (promise, day) into ONE record.

    Not a tidiness pass — `writeFocusSession` APPENDS (it must never `replace`,
    which would collapse the day), so four pomodoros on one task on one day are
    four entries. Left unmerged, that day would emit four rows carrying the same
    date, and each of them would report the whole day's attributed seconds,
    because the overlap buckets are keyed by (promise, day) and every one of the
    four would read the same bucket. The day's minutes would be right and every
    sensor number beside them multiplied by four.

    Minutes SUM, windows concatenate (re-sorted, since the overlap scan
    short-circuits on order), `precise` is AND (one envelope-only session makes
    the day's attribution an upper bound) and `truncated` is OR (one capped run
    makes the day's total a floor). Both flags degrade rather than average:
    a day that is partly imprecise is imprecise.
    """
    merged: dict[tuple[int, _date], FocusEntry] = {}
    for e in entries:
        key = (e.promise_id, e.day)
        prev = merged.get(key)
        if prev is None:
            merged[key] = FocusEntry(
                promise_id=e.promise_id,
                title=e.title,
                day=e.day,
                minutes=e.minutes,
                windows=list(e.windows),
                precise=e.precise,
                truncated=e.truncated,
            )
            continue
        prev.minutes += e.minutes
        prev.windows.extend(e.windows)
        prev.precise = prev.precise and e.precise
        prev.truncated = prev.truncated or e.truncated
        prev.title = prev.title or e.title
    for e in merged.values():
        e.windows.sort()
    return sorted(merged.values(), key=lambda e: (e.promise_id, e.day))


def attribute_intervals(entries, intervals) -> dict:
    """Overlap attention intervals onto focus windows.

    `entries` is a list of FocusEntry; `intervals` is `(id, name, start, end)`
    with naive-UTC datetimes. Returns `{(promise_id, day): {name: [sec, count]}}`.

    Pure, so the rule is testable without a database — the same reason
    `device_activity.opens_from_intervals` is.

    An interval is COUNTED once per (promise, day, name) however many of that
    day's windows it spans: a tab open across three pomodoros is one visit to
    that host, and counting it three times would make the count read as
    switching that never happened. Its SECONDS are summed across the windows,
    because those are genuinely three separate stretches of attributed time.
    """
    out: dict = {}
    seen: dict = {}
    for ent in entries:
        key = (ent.promise_id, ent.day)
        bucket = out.setdefault(key, {})
        seen_here = seen.setdefault(key, set())
        if not ent.windows:
            continue
        # Cheap outer bound so a day's entry doesn't walk a month of intervals
        # window-by-window just to find nothing.
        ent_start = ent.windows[0][0]
        ent_end = max(w[1] for w in ent.windows)
        for iid, name, i0, i1 in intervals:
            if not name or i1 <= ent_start or i0 >= ent_end:
                continue
            sec = 0.0
            for w0, w1 in ent.windows:
                # Windows are sorted, so once one starts at or after the
                # interval's end nothing later can overlap either.
                if w0 >= i1:
                    break
                sec += overlap_seconds(w0, w1, i0, i1)
            if sec <= 0:
                continue
            slot = bucket.setdefault(name, [0.0, 0])
            slot[0] += sec
            if (name, iid) not in seen_here:
                seen_here.add((name, iid))
                slot[1] += 1
    return out


def rank(names: dict, *, label_fn=None, top_n: int = TOP_N) -> tuple[list[dict], float]:
    """`{name: [sec, count]}` → the ranked head, plus the tail's seconds.

    Returns `(rows, other_sec)`. The tail is returned rather than dropped so a
    caller can say how much it isn't showing — a head presented as the whole is
    the silent-cap failure, and here it would read as "you were only on these
    ten things".
    """
    ordered = sorted(names.items(), key=lambda kv: (-kv[1][0], kv[0]))
    head = ordered[:top_n]
    other = sum(sec for _, (sec, _) in ordered[top_n:])
    rows = [
        {
            "name": name,
            "label": label_fn(name) if label_fn else name,
            "seconds": round(sec, 1),
            "intervals": count,
        }
        for name, (sec, count) in head
    ]
    return rows, round(other, 1)


# ── the database side ────────────────────────────────────────────────────────


def _focus_entries(db: Session, *, start_day: _date, end_day: _date) -> list[FocusEntry]:
    """Every attributable focus session-day in `[start_day, end_day]`."""
    from . import trackable_service

    t = trackable_service.get_by_name(db, FOCUS_TRACKABLE)
    if t is None:
        # Nobody has ever run a session — the client get-or-creates the
        # definition on the first write. Not an error, just an empty answer.
        return []
    rows = trackable_service.entries_for(db, t, start=start_day, end=end_day)
    out = []
    for e in rows:
        parsed = parse_focus_entry(e.date, e.value_numeric, e.value_json)
        if parsed is not None:
            out.append(parsed)
    return out


def _intervals(db: Session, model, name_col, span_start, span_end, *, layer: str):
    """One interval table's rows OVERLAPPING `[span_start, span_end)`, capped.

    The exact predicate is `started_at < span_end AND ended_at > span_start`,
    but only `started_at` is indexed on both tables (see `device_activity`'s
    SCAN_REACH for the same problem), so the query is an INDEXED PREFILTER —
    `started_at > span_start - MAX_INTERVAL_SEC` — plus that exact predicate.
    The prefilter is provably sufficient because `interval_ingest` REJECTS any
    interval longer than MAX_INTERVAL_SEC, which is why the cap is imported
    rather than restated.

    Returns `(rows, capped)`. Truncation takes the NEWEST rows and is reported
    to the caller, never swallowed: an under-attributed window that says so is
    a gap a reader can see, and one that doesn't is a wrong number.
    """
    reach = timedelta(seconds=MAX_INTERVAL_SEC)
    try:
        newest_first = (
            db.query(model.id, name_col, model.started_at, model.ended_at)
            .filter(
                model.started_at > span_start - reach,
                model.started_at < span_end,
                model.ended_at > span_start,
            )
            .order_by(model.started_at.desc())
            .limit(MAX_SCAN_INTERVALS + 1)
            .all()
        )
    except Exception as e:  # pragma: no cover — defensive, one sensor must not
        print(f"[focus_attribution] {layer} interval query failed: {e}")
        return [], False
    capped = len(newest_first) > MAX_SCAN_INTERVALS
    rows = list(reversed(newest_first[:MAX_SCAN_INTERVALS]))
    if capped:
        print(
            f"[focus_attribution] {layer} scan hit MAX_SCAN_INTERVALS "
            f"({MAX_SCAN_INTERVALS}); attributed seconds for this read are a "
            f"FLOOR — a narrower read covers the rest"
        )
    return rows, capped


def attribute(
    db: Session,
    *,
    start_day: _date,
    end_day: _date,
    promise_id: int | None = None,
) -> dict:
    """What each commitment's focus sessions actually observed, per local day.

    Days are `datetime.date`, inclusive, and are the ENTRY's own `date` column
    rather than a bound recomputed here. That column is the local day
    `focusTime.ts::splitSegmentsByDay` filed the minutes under, and it is the
    day the log matrix already shows them on — recomputing the day from
    `Settings.nudge_tz` would make this read disagree with the column it is
    describing whenever the two clocks differ. Day-binding still holds ("what
    happened on day D" has one answer however the reader arrived at it); it is
    just anchored to the writer's day rather than re-derived.
    `promise_id` narrows to one commitment.

    Shape:
        {start, end, promises: [{promise_id, title, focused_minutes, precise,
         truncated, days: [...], browser: {...}, app: {...}}], warnings: [...]}

    `focused_minutes` is the TIMER's number and nothing else. The sensor rollups
    beside it describe the same window but are not the source of it — a window
    nothing observed still has its minutes, which is exactly the case that must
    not read as zero.
    """
    from ..db.models import AppInterval, BrowserInterval, Promise

    warnings: list[str] = []
    if end_day < start_day:
        return {
            "start": start_day.isoformat(),
            "end": end_day.isoformat(),
            "promises": [],
            "warnings": ["empty range"],
        }

    span = (end_day - start_day).days + 1
    if span > MAX_DERIVED_DAYS:
        start_day = end_day - timedelta(days=MAX_DERIVED_DAYS - 1)
        warnings.append(
            f"asked for {span} days; attributed the newest {MAX_DERIVED_DAYS} "
            f"(from {start_day.isoformat()}) — older days need a narrower read"
        )

    entries = _focus_entries(db, start_day=start_day, end_day=end_day)
    if promise_id is not None:
        entries = [e for e in entries if e.promise_id == promise_id]
    # ONE record per (promise, day) before anything reads a bucket — see
    # `merge_entries` for why four pomodoros would otherwise report four times.
    entries = merge_entries(entries)
    if not entries:
        return {
            "start": start_day.isoformat(),
            "end": end_day.isoformat(),
            "promises": [],
            "warnings": warnings,
        }

    # Query only as wide as the windows actually reach. A range with one
    # 25-minute session in it should not scan the range.
    span_start = min(w[0] for e in entries for w in e.windows)
    span_end = max(w[1] for e in entries for w in e.windows)

    layers = {}
    for key, model, col, label_fn in (
        ("browser", BrowserInterval, BrowserInterval.host, host_label),
        ("app", AppInterval, AppInterval.app, None),
    ):
        rows, capped = _intervals(db, model, col, span_start, span_end, layer=key)
        if capped:
            warnings.append(
                f"{key} scan hit its {MAX_SCAN_INTERVALS}-row cap; its attributed "
                f"seconds are a floor"
            )
        layers[key] = {
            "buckets": attribute_intervals(entries, rows),
            "label_fn": label_fn,
        }

    # Live promise text beats the entry's snapshot title: the entry records the
    # title as it read when the session ended, and a commitment renamed since
    # then would otherwise show under its old name forever. One batched query.
    pids = sorted({e.promise_id for e in entries})
    live = {
        p.id: p
        for p in db.query(Promise).filter(Promise.id.in_(pids)).all()
    }

    by_promise: dict[int, dict] = {}
    for ent in entries:  # already one per (promise, day), sorted
        p = live.get(ent.promise_id)
        rec = by_promise.setdefault(
            ent.promise_id,
            {
                "promise_id": ent.promise_id,
                # Same text `focus_service._serialize_reminder` shows: summary
                # first, the verbatim utterance behind it.
                "title": (
                    (p.summary or p.utterance) if p is not None else ent.title
                ).strip(),
                # A promise deleted since the session ran still has its minutes;
                # the row says so rather than vanishing. Dropping it would make
                # the day's attributed total silently smaller than the log
                # matrix's `focus` cell for the same day.
                "promise_exists": p is not None,
                "state": p.state if p is not None else None,
                "focused_minutes": 0.0,
                "precise": True,
                "truncated": False,
                "days": [],
                "_names": {"browser": {}, "app": {}},
            },
        )
        rec["focused_minutes"] += ent.minutes
        rec["precise"] = rec["precise"] and ent.precise
        rec["truncated"] = rec["truncated"] or ent.truncated

        window_sec = ent.window_seconds()
        day_row = {
            "date": ent.day.isoformat(),
            "focused_minutes": round(ent.minutes, 2),
            "precise": ent.precise,
            "truncated": ent.truncated,
        }
        for key in ("browser", "app"):
            names = layers[key]["buckets"].get((ent.promise_id, ent.day), {})
            observed = sum(sec for sec, _ in names.values())
            rows, other = rank(names, label_fn=layers[key]["label_fn"])
            day_row[key] = {
                "observed_sec": round(observed, 1),
                # How much of the window ANY interval on this layer covered.
                # A sensor's own answer about itself: 0.0 means nothing was
                # recorded, which is what an uninstalled extension looks like
                # and is NOT the same claim as "no browsing happened".
                "coverage": round(min(1.0, observed / window_sec), 3) if window_sec > 0 else None,
                "top": rows,
                "other_sec": other,
            }
            agg = rec["_names"][key]
            for name, (sec, count) in names.items():
                slot = agg.setdefault(name, [0.0, 0])
                slot[0] += sec
                slot[1] += count
        rec["days"].append(day_row)

    out = []
    for rec in by_promise.values():
        for key in ("browser", "app"):
            rows, other = rank(rec["_names"][key], label_fn=layers[key]["label_fn"])
            observed = sum(sec for sec, _ in rec["_names"][key].values())
            rec[key] = {"observed_sec": round(observed, 1), "top": rows, "other_sec": other}
        rec.pop("_names")
        rec["focused_minutes"] = round(rec["focused_minutes"], 2)
        rec["days"].sort(key=lambda d: d["date"], reverse=True)
        out.append(rec)
    out.sort(key=lambda r: -r["focused_minutes"])

    return {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "promises": out,
        "warnings": warnings,
    }
