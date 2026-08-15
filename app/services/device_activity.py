"""The DEVICE vocabulary — one language for every "opened X" row Gooni shows.

Three sensors report what Daniel touched, and until now only one of them said
so anywhere he could see it:

  - iOS Shortcuts pings        → a per-`"{subject} {event}"` Trackable
                                 (`event_service`), rendered "opened instagram"
  - the Chrome extension       → `browser_intervals` (tab focus)
  - the Electron shell         → `app_intervals` (frontmost macOS app)

This module turns all three into the SAME row. It owns two things:

**The phrase.** `event_phrase` rewrites the Shortcuts trackable name
("instagram open") into a sentence ("opened instagram"); the two interval
sensors build the same sentence from their own name. One function so the
vocabulary can't fork.

**The gap rule.** An interval sensor closes an interval on every switch — that
is what makes its durations honest and what makes it useless as a log: a normal
day is hundreds of tab switches and app switches. So an OPEN happens only on the
first focus of a name after `OPEN_GAP` away from it. Alt-tabbing to Slack and
back does not open anything; coming back to Slack after lunch does.

**And the clustering.** The gap rule alone is not enough, which is a measured
fact rather than a guess: over a simulated workday of 860 intervals across 14
hosts and 8 apps it yields 408 rows, because with a dozen names in rotation you
genuinely leave each of them for five minutes several times an hour. So opens
are then chained into RUNS the same way `event_service` already chains the
phone's Shortcuts pings — one row per run, carrying the count — which takes the
same day to 39. That is not a second invention: it is the existing device-row
rule, and `CLUSTER_GAP` below is the constant `event_service` now imports, so
all three sensors group identically instead of by coincidence.

The two knobs answer different questions and that is why there are two: the gap
decides what an open IS ("opened" must mean opened, not touched), the cluster
decides how many ROWS a day of opens is worth.

**And the window is a LOCAL CALENDAR DAY, not the reader's paging cursor.**
Derivation used to run over `[cursor - lookback, cursor)`, which made the answer
a function of how you got there: a run's `×N` counted only the opens older than
whatever cursor happened to ask, so the same afternoon read `×5` on one page and
`×3` on the next, and a span the cursor jumped over was derived by no page at
all. Both were the same bug wearing different clothes, so the seam moved instead
of getting a third patch. "What opened on day D" now has ONE answer; callers
SELECT days, they do not define windows. A run crossing local midnight splits
into one row per day, each anchored at its own first open — the grammar
`focusTime.ts::splitSegmentsByDay` already uses for focus sessions.

Deliberately NOT attribution. These rows say what happened and when. Nothing
here scores a day, binds attention to a Promise, or computes a percentage —
`browser_intervals`/`app_intervals` stay the honest raw substrate, and
presenting a row is not reading it that way. Binding attention to a commitment
is `focus_attribution`'s job and only happens inside a focus session's windows;
the two modules read the same tables and share `host_label`, `CLUSTER_GAP`'s
neighbours and the scan caps, but a device ROW never carries a promise and an
attributed second never becomes a row.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .interval_ingest import MAX_INTERVAL_SEC

# ── the two tuning knobs ─────────────────────────────────────────────────────
#
# How long you must be AWAY from an app or a host before returning to it counts
# as opening it again.
#
# This is the whole difference between a log and a firehose. Five minutes was
# chosen so that a normal day adds a readable handful of rows: switching to
# Slack to answer a message and back is one continuous stretch of work on the
# thing you were doing, not two openings, while a gap long enough to have done
# something else in is a genuine return. Raise it if the log still reads busy;
# lower it if a real context switch is being swallowed. It is ONE constant on
# purpose — both layers read it, so the two can never disagree about what
# "opened" means, which is the only reason they read as one vocabulary.
OPEN_GAP = timedelta(minutes=5)

# How long a name must go WITHOUT being opened before the next open starts a new
# ROW rather than adding to the last one's count.
#
# Sixty minutes, and not chosen freshly: it is the number `event_service` has
# always used to collapse a run of Shortcuts pings into one card, under the same
# reasoning ("aggregate hard — one card per run, not per app-switch"). This
# module now owns it and event_service imports it, so the phone, the browser and
# the Mac cannot drift into grouping differently.
#
# Chained, like event_service's: each open within the window extends the run
# rather than measuring from its start. A host you dip into every forty minutes
# all afternoon is one line that says so, which is the true shape of that
# afternoon; six lines would be a worse description of the same fact.
CLUSTER_GAP = timedelta(minutes=60)

# ── the reach-back: how far before a window the evidence for it lives ────────
#
# How far back a read has to LOOK to judge the first open inside its window. An
# interval that ENDED this recently is the evidence that makes the window's
# first interval a continuation rather than an opening.
GAP_REACH = OPEN_GAP + CLUSTER_GAP

# …and how far back it has to QUERY to be certain of finding that evidence.
#
# Relevance as a predecessor is decided by when an interval ENDED, not when it
# started, and a session longer than GAP_REACH is ordinary rather than exotic:
# idle only closes an interval after ~a minute of no input, so Cursor frontmost
# 21:30 → 00:20 is one row, and it is the true predecessor of a 00:22 focus. A
# lower bound on `started_at` alone therefore misses it and manufactures exactly
# the fake midnight "opened" the reach-back exists to prevent.
#
# The query is an INDEXED PREFILTER PLUS AN EXACT PREDICATE, not a swap to
# `ended_at`: only `started_at` is indexed on both tables, so filtering on
# `ended_at` alone would turn every derivation into a full table scan. The
# indexed lower bound is widened by the longest interval the ingest can possibly
# have accepted, and `ended_at >= start - GAP_REACH` does the real cutting.
# That widening is provably sufficient ONLY because `interval_ingest` REJECTS
# anything longer than MAX_INTERVAL_SEC — moving that cap moves this, which is
# why it is imported rather than restated as a literal here.
SCAN_REACH = GAP_REACH + timedelta(seconds=MAX_INTERVAL_SEC)

# The most interval rows ONE sensor's derivation will pull into Python for ONE
# read. Not a tuning knob for what the log says — a bound on what it costs to
# say it.
#
# The gap rule is a forward scan, so unlike every other activity source this one
# cannot page with `ORDER BY … DESC LIMIT n` (see `_sensor_rows`); it reads a
# WINDOW. That is affordable over the few days a page usually wants (~860
# intervals/day measured), and it is the widest reads — a month at
# MAX_DERIVED_DAYS — that would otherwise materialise ~27k rows per table.
#
# Truncation is at the OLD edge (the newest N survive), because the recent days
# are the ones a reader is actually looking at. A day the scan only half read is
# DROPPED rather than reported: a missing row is a gap, a half-counted day is a
# wrong number, and a wrong number is what day-binding exists to remove. Both
# tables are capped independently: either can be the dense one, and a quiet
# browser is no reason to starve the app scan.
MAX_SCAN_INTERVALS = 10_000

# The most LOCAL DAYS one read will derive.
#
# Day-binding makes "what opened on day D" a fixed question, but it does not
# bound how many days a caller may ask about, and a derived source's cost scales
# with how much the sensors recorded rather than with how many rows come out.
# Thirty-one days is the span `browser_activity_service.MAX_SUMMARY_DAYS` allows
# its SQL fold, for the same reason. Excess is trimmed from the OLD end and
# logged — an older read covers what was trimmed.
MAX_DERIVED_DAYS = 31

# ── the phrase ───────────────────────────────────────────────────────────────

# Shortcuts device pings store as a raw "{subject} {event}" trackable name
# ("instagram open", "office arrive") with a meaningless per-ping +1 count.
# Rephrase the common verbs into a sentence and drop the count. Unknown shapes
# pass through untouched (the device vocab is open-ended server-side).
# Match BASE and past forms: iOS Shortcuts sends the imperative ("instagram
# open", "office arrive"), not past tense. `opened?`/`locked?` only reach
# "opene"/"locke"+d, so the bare verbs slipped through untouched — hence
# `(?:ed)?` on the consonant-final stems.
_EVENT_VERB = re.compile(
    r"^(.*?)\s+(arrived?|left|leave|open(?:ed)?|closed?|unlock(?:ed)?|lock(?:ed)?|charging|plugged)$",
    re.IGNORECASE,
)


def event_phrase(name: str) -> str:
    """"instagram open" → "opened instagram". Unknown shapes pass through."""
    s = (name or "").strip()
    m = _EVENT_VERB.match(s)
    if not m:
        return s
    subject, verb = m.group(1).strip(), m.group(2).lower()
    if verb.startswith("arriv"):
        return f"arrived at {subject}"
    if verb in ("left", "leave"):
        return f"left {subject}"
    if verb.startswith("open"):
        return f"opened {subject}"
    if verb.startswith("close"):
        return f"closed {subject}"
    if verb.startswith("unlock"):
        return f"unlocked {subject}"
    if verb.startswith("lock"):
        return f"locked {subject}"
    return s


# Cosmetic only — the raw host stays on the row as `name`, and nothing keys off
# the label. `www.` goes because it is never information, and a trailing
# well-known TLD goes because "opened leetcode" reads like the phone's rows
# while "opened leetcode.com" reads like a URL bar. A host whose last label
# isn't in this set is left ENTIRELY alone rather than guessed at: chopping the
# tail off `mail.google.co.uk` or an intranet name would misname the thing,
# which is worse than a slightly technical label.
_COMMON_TLDS = frozenset(
    {"com", "org", "net", "io", "dev", "app", "co", "ai", "so", "sh", "me", "gg", "xyz", "tv"}
)


def host_label(host: str) -> str:
    """`www.leetcode.com` → `leetcode`; `mail.google.com` → `mail.google`."""
    h = (host or "").strip().lower()
    if h.startswith("www."):
        h = h[4:]
    parts = h.split(".")
    if len(parts) >= 2 and parts[-1] in _COMMON_TLDS:
        return ".".join(parts[:-1])
    return h


# ── the gap rule ─────────────────────────────────────────────────────────────


def opens_from_intervals(rows, *, gap: timedelta = OPEN_GAP, since: datetime | None = None):
    """Reduce a stream of attention intervals to the OPENS in it.

    `rows` is an iterable of `(key, name, started_at, ended_at)` sorted ASCENDING
    by `started_at`, with naive-UTC datetimes. Yields `(key, name, started_at)`
    for each interval that begins at least `gap` after the last time attention
    on that same `name` ended — plus the first interval seen for a name, which
    has nothing to be a continuation of.

    `since` drops opens older than a cutoff AFTER the rule has run, which is
    what lets the caller feed in a lookback window: an interval just before the
    window is not a row to show, but it IS the evidence that the first interval
    inside the window is a continuation rather than an opening. Filtering the
    lookback out first would manufacture an "opened" row at the start of every
    window.

    Pure, so the rule is testable without a database — the reason it lives here
    rather than inline in a query.
    """
    last_end: dict[str, datetime] = {}
    out: list[tuple] = []
    for key, name, started, ended in rows:
        prev = last_end.get(name)
        if prev is None or (started - prev) >= gap:
            if since is None or started >= since:
                out.append((key, name, started))
        # max(), not assignment: intervals for one name should never overlap,
        # but a sensor that double-reports (or a clock that jumped) must not be
        # able to move the "last seen" marker BACKWARDS and mint a false open.
        last_end[name] = ended if prev is None else max(prev, ended)
    return out


def cluster_opens(opens, *, gap: timedelta = CLUSTER_GAP):
    """Chain a name's opens into RUNS: one row per run, timed at its FIRST open.

    `opens` is `(key, name, started_at)` in any order; the return is a list of
    `{key, name, at, count}`, one per run. Chained, so each open within `gap` of
    the previous one extends the run rather than measuring from its start — the
    same rule `event_service.list_recent_events` uses on the phone's pings.

    Timed at the FIRST open, which is where this deliberately DIVERGES from
    event_service (that stamps a run at its latest ping). A row that says
    "opened cursor" has to sit at the moment it was opened; anchoring at the
    latest open put every all-day name at the END of the day, which measured out
    as 18 of a 39-row day landing in one hour and reading as a burst of activity
    that never happened.

    The first open is also the STABLE anchor, and with day-bound windows it is a
    stable KEY: callers run this over one local day's opens, so a run's anchor is
    its first open within that day and cannot move when a different reader asks
    about the same day. A run that spans midnight yields one row per day, each
    anchored at its own first open.
    """
    runs: dict[str, dict] = {}
    out: list[dict] = []
    for key, name, at in sorted(opens, key=lambda o: o[2]):
        run = runs.get(name)
        if run is not None and (at - run["last"]) <= gap:
            run["last"] = at
            run["count"] += 1
            continue
        run = {"key": key, "name": name, "at": at, "last": at, "count": 1}
        runs[name] = run
        out.append(run)
    return out


def _sensor_rows(db: Session, model, name_col, *, start, end, layer):
    """One interval table's rows for `[start, end)`, ascending, capped.

    The query REACHES BACK before `start` so the gap rule can judge the first
    interval in the window. That grace is what stops a continuation from being
    reported as an opening at the window's leading edge, and under day-binding
    the edge it protects is local midnight: an interval that ENDED at 23:58 is
    exactly the evidence that makes one at 00:01 a continuation, and without it
    every midnight manufactures an "opened" for whatever was on screen. The
    predecessor is selected by `ended_at` (see SCAN_REACH for why the indexed
    `started_at` bound is the prefilter and not the cut).

    Returns `(rows, floor)`. `floor` is the earliest moment this scan can speak
    for — normally `start`, but when `MAX_SCAN_INTERVALS` bites it rises to the
    oldest surviving interval plus SCAN_REACH: a row cut away could itself have
    run up to MAX_INTERVAL_SEC past its own start, so nothing within that span of
    the truncation boundary can be judged. Truncation takes the NEWEST rows, and
    the caller derives only the days that begin at or after the floor
    (`fully_derived_days`), because a predecessor that was cut away is not
    evidence of absence: counting it as one would put a fake "opened" at the
    truncation boundary, and reporting the day the floor cuts INTO would re-anchor
    its runs and undercount them. What survives is whole days of whole runs with
    whole counts — the cap can cost a row, never a wrong number.
    """
    newest_first = (
        db.query(model.id, name_col, model.started_at, model.ended_at)
        .filter(
            model.started_at >= start - SCAN_REACH,
            model.started_at < end,
            model.ended_at >= start - GAP_REACH,
        )
        .order_by(model.started_at.desc())
        .limit(MAX_SCAN_INTERVALS + 1)
        .all()
    )
    capped = len(newest_first) > MAX_SCAN_INTERVALS
    rows = list(reversed(newest_first[:MAX_SCAN_INTERVALS]))
    floor = start
    if capped and rows:
        floor = max(start, rows[0][2] + SCAN_REACH)
        print(
            f"[device_activity] {layer} scan hit MAX_SCAN_INTERVALS "
            f"({MAX_SCAN_INTERVALS}); opens before {floor.isoformat()} are not "
            f"derived on this read — a narrower read covers them"
        )
    return rows, floor


def fully_derived_days(days, bounds, floor):
    """The days a scan reaching back only to `floor` can speak for WHOLE.

    `days` is the ascending day list, `bounds` maps each to its `[start, end)`
    in naive UTC. A day qualifies only when its own start is at or after the
    floor — the floor already carries the full `SCAN_REACH` a day needs to judge
    its first open, so a day at or above it was scanned completely, evidence and
    all. It is keyed to that reach rather than to the gap constants directly,
    because the evidence a day needs includes a predecessor that may have
    STARTED up to MAX_INTERVAL_SEC earlier.

    The boundary is a function rather than a comparison buried in the loop
    because it is the answer to "which is the oldest fully-derived day", and a
    half-read day must be DROPPED, never reported: it would re-anchor its runs at
    the first surviving open and undercount them, so the same local day would
    read differently depending on how wide the read happened to be — the exact
    bug day-binding exists to remove. A missing row is a gap the reader can see;
    a half-counted day is a wrong number.
    """
    return [d for d in days if bounds[d][0] >= floor]


def device_opens(db: Session, *, start_day, end_day) -> list[dict]:
    """Every `opened X` row for the LOCAL days `[start_day, end_day]`, newest-first.

    Days are `datetime.date` in Daniel's tz (`Settings.nudge_tz`), inclusive.
    Each item: `{layer, day, key, name, label, at, count, phrase, text}` —
    `phrase` is the sentence alone ("opened cursor") and `text` appends the
    `×N` a clustered run carries. Two fields rather than two call sites building
    the verb: the timeline renders `×count` itself and would otherwise print it
    twice, and a second `f"opened {...}"` somewhere else is exactly the fork this
    module exists to prevent.

    The window is the DAY, never the caller's cursor, so a past day's rows do not
    depend on how the reader arrived at them. Wrapped defensively per sensor: a
    schema drift in one table must not take the whole feed down with it.
    """
    from ..common import local_day_bounds, local_now
    from ..db.models import AppInterval, BrowserInterval

    if end_day < start_day:
        return []
    span = (end_day - start_day).days + 1
    if span > MAX_DERIVED_DAYS:
        start_day = end_day - timedelta(days=MAX_DERIVED_DAYS - 1)
        print(
            f"[device_activity] read asked for {span} days; derived the newest "
            f"{MAX_DERIVED_DAYS} (from {start_day.isoformat()}) — older days need "
            f"a narrower read"
        )

    tz = local_now(db).tzinfo
    days = [start_day + timedelta(days=i) for i in range((end_day - start_day).days + 1)]
    bounds = {d: local_day_bounds(tz, d) for d in days}
    span_start = bounds[days[0]][0]
    span_end = bounds[days[-1]][1]

    items: list[dict] = []
    for model, col, layer, label_fn in (
        (BrowserInterval, BrowserInterval.host, "browser", host_label),
        (AppInterval, AppInterval.app, "app", lambda n: n),
    ):
        try:
            rows, floor = _sensor_rows(
                db, model, col, start=span_start, end=span_end, layer=layer
            )
            opens = opens_from_intervals(rows, since=max(span_start, floor))
        except Exception as e:  # pragma: no cover — defensive
            print(f"[device_activity] {layer} opens query failed: {e}")
            continue

        derived = fully_derived_days(days, bounds, floor)
        if len(derived) < len(days):
            dropped = [d for d in days if d not in derived]
            print(
                f"[device_activity] {layer} scan can only speak from "
                f"{floor.isoformat()}; dropped {len(dropped)} partially-scanned "
                f"day(s) {dropped[0].isoformat()}..{dropped[-1].isoformat()} — "
                f"oldest fully-derived day is "
                f"{derived[0].isoformat() if derived else 'none'}; a narrower "
                f"read covers the rest"
            )

        for day in derived:
            day_start, day_end = bounds[day]
            in_day = [
                (f"{key}", name, at) for key, name, at in opens if day_start <= at < day_end
            ]
            for run in cluster_opens(in_day):
                items.append(
                    {
                        "layer": layer,
                        "day": day.isoformat(),
                        "key": f"device-{layer}-{run['key']}",
                        "name": run["name"],
                        "label": label_fn(run["name"]),
                        "at": run["at"],
                        "count": run["count"],
                    }
                )

    for it in items:
        it["phrase"] = f"opened {it['label']}"
        it["text"] = it["phrase"] + (f" ×{it['count']}" if it["count"] > 1 else "")
    items.sort(key=lambda it: it["at"], reverse=True)
    return items
