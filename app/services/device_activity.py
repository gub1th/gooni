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

Deliberately NOT attribution. These rows say what happened and when. Nothing
here scores a day, binds attention to a Promise, or computes a percentage —
`browser_intervals`/`app_intervals` stay the honest raw substrate a later
attribution design would read, and presenting a row is not reading it that way.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

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

    The first open is also the STABLE anchor, which is what makes it safe for a
    feed that pages over a sliding window: a run's start is decided only by what
    precedes it, and `device_opens` looks back far enough to see that. A run that
    began before the window is re-anchored outside it and dropped — it belongs to
    the older page, where it appears exactly once.
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


def _interval_opens(db: Session, model, name_col, *, start, end, layer, label_fn):
    """Gap rule then clustering, over one interval table, for a naive-UTC window.

    The query reaches back further than the window on purpose, and by two
    different amounts for two different reasons:

      - `OPEN_GAP`, so the first interval inside the window can be JUDGED — a
        continuation whose evidence sits outside the window would otherwise be
        reported as an opening at every page's leading edge;
      - `CLUSTER_GAP`, so an open at the window's leading edge can be recognised
        as a CONTINUATION of a run that began just before it. Without that, the
        same run starts again at every page boundary and prints twice.

    Runs anchored before `start` are dropped at the end; they belong to the
    older page, where their first open is inside the window.
    """
    lookback = OPEN_GAP + CLUSTER_GAP
    rows = (
        db.query(model.id, name_col, model.started_at, model.ended_at)
        .filter(model.started_at >= start - lookback, model.started_at < end)
        .order_by(model.started_at.asc())
        .all()
    )
    opens = opens_from_intervals(rows, since=start - CLUSTER_GAP)
    return [
        {
            "layer": layer,
            "key": f"device-{layer}-{run['key']}",
            "name": run["name"],
            "label": label_fn(run["name"]),
            "at": run["at"],
            "count": run["count"],
        }
        for run in cluster_opens([(f"{key}", name, at) for key, name, at in opens])
        if run["at"] >= start
    ]


def device_opens(db: Session, *, start: datetime, end: datetime) -> list[dict]:
    """Every `opened X` row from BOTH interval sensors in `[start, end)`, newest-first.

    `start`/`end` are naive UTC (the storage convention). Each item:
    `{layer, key, name, label, at, count, text}` — `text` is the rendered
    sentence (with a `×N` when the run is more than one open, exactly as the
    timeline renders a clustered Shortcuts card), `name` the raw host/app.

    Wrapped defensively per sensor: a schema drift in one table must not take
    the whole activity feed down with it (the same posture every source in
    `activity_service` takes).
    """
    from ..db.models import AppInterval, BrowserInterval

    items: list[dict] = []
    for model, col, layer, label_fn in (
        (BrowserInterval, BrowserInterval.host, "browser", host_label),
        (AppInterval, AppInterval.app, "app", lambda n: n),
    ):
        try:
            items += _interval_opens(
                db, model, col, start=start, end=end, layer=layer, label_fn=label_fn
            )
        except Exception as e:  # pragma: no cover — defensive
            print(f"[device_activity] {layer} opens query failed: {e}")

    for it in items:
        it["text"] = f"opened {it['label']}" + (f" ×{it['count']}" if it["count"] > 1 else "")
    items.sort(key=lambda it: it["at"], reverse=True)
    return items
