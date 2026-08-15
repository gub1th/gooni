"""What Daniel is DOING right now — the device sensors' half of the state block.

`recent_activity` tells Gooni what CHANGED in the last hour (a promise closed, a
trackable logged, a Whoop sync). This module tells it what Daniel has been
LOOKING AT for the last ~30 minutes, and — when a focus session is live — what
he said that time was for.

The hole it closes: three sensors have been writing attention to the database
for months (the Chrome extension → `browser_intervals`, the Electron shell →
`app_intervals`, and the focus page → the `focus_cam` control blob), and the
orchestrator read none of them. So Gooni answered "what have I been doing?" from
scrollback, and could not tell heads-down-in-Cursor-for-three-hours from
twenty-minutes-of-YouTube-during-a-focus-session. Every input here already
existed; nothing new is captured.

**Read-only, and derived at read time.** No table, no column, no migration, no
Trackable, no model call — a bounded query over the two interval tables plus the
`focus_cam` blob, folded in Python. Writing anything from here would repeat the
mistake `focus_attribution` exists to avoid (both sensors BUFFER, so an interval
measured at 14:30 legitimately lands at 18:00 and must never be stamped with
whatever is true when it arrives).

**It states, it does not judge.** There is no score, no percentage of the window
called productive, no "aligned / not aligned" verdict — the same line
`focus_attribution` and `device_activity` both refuse to cross. What this block
gives the LLM is the two facts side by side: the commitment the running session
is FOR, and the apps and hosts the sensors actually observed. Reading alignment
off that pair is the model's job; minting a judgement deterministically and
handing it over as a fact is not.

**Four honesty rules**, each the inverse of a way this block could lie:

  1. **Observed ≠ elapsed.** The sensors cover part of the window at best (an
     uninstalled extension, a closed laptop and a genuinely quiet half-hour are
     all "no rows"). So the block reports how much of the window anything
     observed, and never fills the remainder with a claim.
  2. **No data is stated, not implied.** With nothing observed and no live
     session, the block says `no recent activity data` rather than going
     silent or claiming Daniel was idle — absence of sensor data is not
     evidence of absence of the human, but a silently-omitted section is
     indistinguishable from "nothing worth mentioning", and the model needs to
     tell "sensors saw nothing" apart from "sensors weren't asked".
  3. **A stale control blob is not a live session.** The focus page clears
     `control` on unmount, but a hard tab close never runs that cleanup, so a
     bare `control == "running"` can outlive its session indefinitely. A session
     is claimed only when the blob carries a server-stamped `control_at` that is
     inside `MAX_RUN` — the same 6h cap `focusTime.ts` puts on an open run. An
     older stamp, or none at all, reads as no session.
  4. **A salvaged span is a floor.** `truncated` intervals (browser killed, Mac
     slept, sensor wedged) are counted — dropping them understates the window —
     and the block says so rather than presenting a floor as a measurement.

Bounded by construction: one 30-minute window, a handful of ranked names per
layer with the tail counted rather than dropped, and at most ~7 lines. Well
under the ~500-token budget the state block can afford.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .interval_ingest import MAX_INTERVAL_SEC, parse_dt

# How far back "right now" reaches. Half an hour is long enough to show the
# shape of what he's on and short enough that it is still true when Gooni
# answers — an hour of app switches describes a morning, not a moment.
WINDOW_MINUTES = 30

# Ranked names per layer. The head answers "what was I on"; the tail is noise,
# and is COUNTED into an `+N more` rather than silently dropped.
TOP_APPS = 4
TOP_HOSTS = 5

# Names below this contribute to the totals but never earn their own slot — a
# 4-second alt-tab is not a thing you were doing.
MIN_NAMED_SEC = 20.0

# Most rows one layer's query pulls for one read. A half-hour of honest sensing
# is well under 200 intervals per table; this bounds a duplicate flood or a
# misbehaving client, and truncation takes the NEWEST rows, so the numbers
# become a floor rather than a wrong shape (and the block says so).
MAX_ROWS = 2_000

# How long the sensors must have recorded nothing before the block says so. Two
# minutes, because intervals close on idle after ~a minute of no input, so a
# shorter gap is the ordinary seam between two intervals rather than a signal.
QUIET_GAP = timedelta(minutes=2)

# The line between "this is what I'm doing" and "this is what I was doing".
# Below this age a layer's folded seconds are presented as current state
# ("apps: cursor 12m"); at or past it they're presented as a fact about the
# past ("apps — last seen 2h ago: cursor") so a stale interval can't read as
# a live one. 15 minutes, named per the staleness-awareness brief — long
# enough that an ordinary short away-from-keyboard gap (already surfaced via
# `QUIET_GAP`) doesn't flip the framing on its own.
STALE_THRESHOLD = timedelta(minutes=15)

# The longest a focus run can honestly be. Mirrors `useFocusSessionStore`'s
# MAX_RUN_MS — the client caps an open run at six hours, so a `control_at` older
# than that describes a session the client has already stopped counting.
MAX_RUN = timedelta(hours=6)

# End reasons that mean the HUMAN left, as opposed to the attention simply
# moving somewhere else. Used only to phrase the quiet line; never to claim a
# duration nothing observed.
_AWAY_REASONS = {"idle", "locked", "suspended"}

# Window titles are the one free-form string in here.
_TITLE_MAX = 45


# ── formatting ───────────────────────────────────────────────────────────────


def fmt_dur(seconds: float) -> str:
    """`95` → `2m`, `40` → `40s`, `4830` → `1h 20m`.

    Rounded at the RENDER boundary, the same rule `focusTime.ts::fmtMinutes`
    follows: the fractional seconds are the honest sum, and a state block full of
    `13.7m` reads as precision this block does not have.
    """
    secs = int(round(max(0.0, seconds)))
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hours, rem = divmod(mins, 60)
    return f"{hours}h {rem}m" if rem else f"{hours}h"


def fmt_age(then: datetime, now: datetime) -> str:
    """How long ago `then` was, phrased like `recent_activity._fmt_age`."""
    secs = int((now - then).total_seconds())
    if secs < 60:
        return "just now"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    return f"{mins // 60}h ago"


def _trim(text: str | None, n: int = _TITLE_MAX) -> str:
    s = " ".join((text or "").split())
    if len(s) <= n:
        return s
    return s[:n].rstrip() + "…"


# ── the pure fold ────────────────────────────────────────────────────────────


def fold_intervals(rows, win_start: datetime, win_end: datetime) -> dict:
    """Clip a layer's intervals to the window and fold them by name.

    `rows` is `(name, title, started_at, ended_at, end_reason, truncated)` with
    naive-UTC datetimes. Returns::

        {"names": {name: {"seconds", "truncated_seconds", "title", "title_sec"}},
         "observed_seconds": float, "spans": [(lo, hi), ...],
         "last_end": datetime|None, "last_reason": str|None}

    CLIPPED, not counted whole: an interval that started 50 minutes ago and is
    still the one you're in contributes only its overlap with the window. Same
    rule as `focus_attribution.overlap_seconds`, and for the same reason — an
    interval straddling the boundary is the ORDINARY case, since intervals close
    on switches and idle rather than on the half hour.

    Pure, so the arithmetic is testable without a database.
    """
    names: dict[str, dict] = {}
    spans: list[tuple[datetime, datetime]] = []
    observed = 0.0
    last_end: datetime | None = None
    last_reason: str | None = None

    for name, title, started, ended, end_reason, truncated in rows:
        if not name or started is None or ended is None:
            continue
        lo = max(started, win_start)
        hi = min(ended, win_end)
        sec = (hi - lo).total_seconds()
        if sec <= 0:
            continue
        slot = names.setdefault(
            name,
            {"seconds": 0.0, "truncated_seconds": 0.0, "title": "", "title_sec": 0.0},
        )
        slot["seconds"] += sec
        if truncated:
            slot["truncated_seconds"] += sec
        # The longest single stretch supplies the representative title — one
        # title per name, so a busy host can't spend the whole budget.
        if title and sec > slot["title_sec"]:
            slot["title"] = title
            slot["title_sec"] = sec
        observed += sec
        spans.append((lo, hi))
        if last_end is None or ended > last_end:
            last_end = ended
            last_reason = end_reason

    return {
        "names": names,
        "observed_seconds": observed,
        "spans": spans,
        "last_end": last_end,
        "last_reason": last_reason,
    }


def union_seconds(spans) -> float:
    """Wall-clock seconds covered by `spans`, counting overlap ONCE.

    The two layers watch the same clock — the browser is one of the apps — so a
    plain sum of their observed seconds double-counts every minute spent in
    Chrome and can claim 50 minutes of coverage over a 30-minute window. That is
    a number the state block would be asserting and the sensors never said.

    Within a layer, intervals shouldn't overlap; across layers they routinely do.
    Merging both into one union answers the only question the coverage line asks:
    how much of this window did ANYTHING observe.
    """
    merged = 0.0
    cur_lo = cur_hi = None
    for lo, hi in sorted(spans):
        if cur_hi is None:
            cur_lo, cur_hi = lo, hi
            continue
        if lo <= cur_hi:
            cur_hi = max(cur_hi, hi)
            continue
        merged += (cur_hi - cur_lo).total_seconds()
        cur_lo, cur_hi = lo, hi
    if cur_hi is not None:
        merged += (cur_hi - cur_lo).total_seconds()
    return merged


def rank_names(names: dict, *, top_n: int, label_fn=None) -> tuple[list[dict], int, float]:
    """`{name: {...}}` → the ranked head, plus how much the tail hides.

    Returns `(rows, other_count, other_seconds)`. The tail is RETURNED rather
    than dropped so the caller can say how much it isn't showing: a head
    presented as the whole is the silent-cap failure, and here it would read as
    "those were the only things you touched".

    Names under `MIN_NAMED_SEC` are pushed into the tail rather than filtered
    out, so their seconds still count toward the window's observed total.
    """
    ordered = sorted(names.items(), key=lambda kv: (-kv[1]["seconds"], kv[0]))
    head = [(n, d) for n, d in ordered if d["seconds"] >= MIN_NAMED_SEC][:top_n]
    head_names = {n for n, _ in head}
    tail = [(n, d) for n, d in ordered if n not in head_names]
    rows = [
        {
            "name": name,
            "label": label_fn(name) if label_fn else name,
            "seconds": data["seconds"],
            "truncated_seconds": data["truncated_seconds"],
            "title": data["title"],
        }
        for name, data in head
    ]
    return rows, len(tail), sum(d["seconds"] for _, d in tail)


# ── the database side ────────────────────────────────────────────────────────


def _layer_rows(db: Session, model, name_col, title_col, win_start, win_end, *, layer: str):
    """One interval table's rows OVERLAPPING `[win_start, win_end)`, capped.

    The exact predicate is `started_at < win_end AND ended_at > win_start`, but
    only `started_at` is indexed on both tables, so the query is an INDEXED
    PREFILTER — `started_at > win_start - MAX_INTERVAL_SEC` — plus that exact
    predicate. The prefilter is provably sufficient because `interval_ingest`
    REJECTS any interval longer than MAX_INTERVAL_SEC, which is why the cap is
    imported rather than restated here. Same trick, same reason, as
    `focus_attribution._intervals` and `device_activity.SCAN_REACH`.

    Returns `(rows, capped)`. Wrapped defensively per layer: one sensor's schema
    drift must not take the state block down with it.
    """
    reach = timedelta(seconds=MAX_INTERVAL_SEC)
    try:
        newest_first = (
            db.query(
                name_col,
                title_col,
                model.started_at,
                model.ended_at,
                model.end_reason,
                model.truncated,
            )
            .filter(
                model.started_at > win_start - reach,
                model.started_at < win_end,
                model.ended_at > win_start,
            )
            .order_by(model.started_at.desc())
            .limit(MAX_ROWS + 1)
            .all()
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[activity_context] {layer} interval query failed: {e}")
        return [], False
    capped = len(newest_first) > MAX_ROWS
    if capped:
        print(
            f"[activity_context] {layer} window hit MAX_ROWS ({MAX_ROWS}); "
            f"its seconds are a floor for this read"
        )
    return list(newest_first[:MAX_ROWS]), capped


def live_focus_session(db: Session, now: datetime) -> dict | None:
    """The focus session running RIGHT NOW, or None.

    The only server-visible signal that one is live is the `focus_cam` control
    blob: `useFocusCamControl` posts `running` + the target promise id whenever
    focus is ACCRUING and `idle` the moment it isn't (a break, a pause, unmount).
    Session state itself is a client store, so this blob is all there is.

    Which makes rule 3 load-bearing. The unmount clear does not run when a tab is
    killed, so `control == "running"` on its own is a claim with no expiry — it
    would have Gooni announcing a focus session days after it ended. A session is
    therefore claimed only when `control_at` (stamped SERVER-side by
    `focus_cam_service.set_control` on the transition into running) is present
    and inside `MAX_RUN`. A blob written before that field existed reads as no
    session rather than as a session of unknown age: the next `▶ focus` stamps
    it, so the gap self-heals within one session, and an unbounded claim is the
    one failure mode worth refusing outright.

    `elapsed` is the CURRENT RUN, not the whole session — a pause posts `idle`
    and a resume re-stamps — which is the more useful number anyway ("he has been
    heads-down on this for 23 minutes") and is labelled as such by the renderer.
    """
    try:
        from . import focus_cam_service

        blob = focus_cam_service.get_blob(db)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[activity_context] focus-cam blob read failed: {e}")
        return None

    if (blob or {}).get("control") != "running":
        return None

    # `parse_dt` is the ONE stamp parser the interval sensors already go through
    # (offset, trailing Z or epoch → naive UTC); the blob is written by the same
    # server, but a second parser here is a second set of edge cases.
    started = parse_dt(blob.get("control_at"))
    if started is None or now - started > MAX_RUN or started > now + timedelta(minutes=5):
        return None

    pid = blob.get("target_reminder_id")
    if isinstance(pid, bool) or not isinstance(pid, int):
        pid = None

    title = ""
    state = None
    if pid is not None:
        try:
            from ..db.models import Promise

            p = db.query(Promise).filter(Promise.id == pid).first()
            if p is not None:
                # Same text `focus_service._serialize_reminder` shows.
                title = (p.summary or p.utterance or "").strip()
                state = p.state
        except Exception as e:  # pragma: no cover — defensive
            print(f"[activity_context] focus target lookup failed: {e}")

    return {
        "promise_id": pid,
        "title": title,
        "promise_state": state,
        "started_at": started,
        "elapsed_seconds": max(0.0, (now - started).total_seconds()),
    }


def build_activity_summary(
    db: Session, *, window_minutes: int = WINDOW_MINUTES, now: datetime | None = None
) -> dict:
    """The structured summary the renderer formats. See module docstring.

    Shape::

        {"window_minutes", "window_start", "window_end",
         "apps": {"top": [...], "other_count", "other_seconds", "observed_seconds"},
         "browser": {... same ...},
         "observed_seconds", "coverage", "truncated_seconds",
         "quiet_since", "quiet_reason", "capped", "focus": {...}|None}

    `coverage` is a claim about the SENSORS, never about the human — it is the
    share of the window that anything at all observed, and 0.0 is what an
    uninstalled extension and a genuinely closed laptop both look like.
    """
    from ..db.models import AppInterval, BrowserInterval
    from .device_activity import host_label

    now = now or datetime.utcnow()
    minutes = max(1, int(window_minutes))
    win_start = now - timedelta(minutes=minutes)

    layers: dict[str, dict] = {}
    capped_any = False
    for key, model, name_col, title_col, top_n, label_fn in (
        ("apps", AppInterval, AppInterval.app, AppInterval.title, TOP_APPS, None),
        (
            "browser",
            BrowserInterval,
            BrowserInterval.host,
            BrowserInterval.title,
            TOP_HOSTS,
            host_label,
        ),
    ):
        rows, capped = _layer_rows(
            db, model, name_col, title_col, win_start, now, layer=key
        )
        capped_any = capped_any or capped
        folded = fold_intervals(rows, win_start, now)
        top, other_count, other_sec = rank_names(
            folded["names"], top_n=top_n, label_fn=label_fn
        )
        layers[key] = {
            "top": top,
            "other_count": other_count,
            "other_seconds": other_sec,
            "observed_seconds": folded["observed_seconds"],
            # Summed over EVERY name, not just the ranked head: a salvaged span
            # that happens to sit in the tail is still a floor in the totals, and
            # the flag exists to say the numbers are floors.
            "truncated_seconds": sum(
                d["truncated_seconds"] for d in folded["names"].values()
            ),
            "spans": folded["spans"],
            "last_end": folded["last_end"],
            "last_reason": folded["last_reason"],
        }

    # The UNION, not the sum — see `union_seconds`. Chrome frontmost while a tab
    # is focused is one observed minute reported by two sensors, not two.
    observed = union_seconds(
        [sp for l in layers.values() for sp in l["spans"]]
    )
    truncated = sum(l["truncated_seconds"] for l in layers.values())
    window_sec = minutes * 60.0

    # The newest thing either sensor saw end. When that is comfortably in the
    # past, the block says the sensors have been quiet — deliberately phrased as
    # a fact about the sensors, since a dead extension and a human who walked
    # away are the same rows and opposite claims.
    ends = [l["last_end"] for l in layers.values() if l["last_end"] is not None]
    quiet_since = None
    quiet_reason = None
    if ends:
        newest = max(ends)
        if now - newest >= QUIET_GAP:
            quiet_since = newest
            for l in layers.values():
                if l["last_end"] == newest:
                    quiet_reason = l["last_reason"]
                    break

    return {
        "window_minutes": minutes,
        "window_start": win_start,
        "window_end": now,
        "apps": layers["apps"],
        "browser": layers["browser"],
        "observed_seconds": observed,
        # Union / window. Clamped as a belt-and-braces guard: the union of spans
        # already clipped to the window cannot exceed it, so a >1 here would be
        # a bug rather than a big day, and the block must not report one.
        "coverage": min(1.0, observed / window_sec) if window_sec > 0 else None,
        "truncated_seconds": truncated,
        "quiet_since": quiet_since,
        "quiet_reason": quiet_reason,
        "capped": capped_any,
        "focus": live_focus_session(db, now),
    }


# ── the render ───────────────────────────────────────────────────────────────


def _layer_line(prefix: str, layer: dict, *, with_titles: bool, now: datetime) -> str | None:
    if not layer["top"] and not layer["other_count"]:
        return None

    last_end = layer.get("last_end")
    # A layer's OWN recency, not the window's — the browser can be stale while
    # the app layer is fresh (or the reverse), and each must be judged on what
    # it actually last saw. `last_end` is None only when this layer contributed
    # nothing, which the guard above already ruled out.
    if last_end is not None and now - last_end >= STALE_THRESHOLD:
        names = [row["label"] for row in layer["top"]]
        if layer["other_count"]:
            names.append(f"+{layer['other_count']} more")
        return f"{prefix} — last seen {fmt_age(last_end, now)}: " + ", ".join(names)

    parts = []
    for row in layer["top"]:
        piece = f"{row['label']} {fmt_dur(row['seconds'])}"
        title = _trim(row.get("title")) if with_titles else ""
        if title:
            piece += f' ("{title}")'
        parts.append(piece)
    if layer["other_count"]:
        parts.append(
            f"+{layer['other_count']} more ({fmt_dur(layer['other_seconds'])})"
        )
    if not parts:
        return None
    return f"{prefix}: " + " · ".join(parts)


def render_activity_lines(summary: dict) -> list[str]:
    """The structured summary → the state-block lines. Empty list = say nothing.

    Empty is a real answer and the right one when the sensors saw nothing and no
    session is running: a section reading "0m observed" invites the model to
    narrate a quiet half-hour it has no evidence for.
    """
    lines: list[str] = []
    focus = summary.get("focus")
    now = summary["window_end"]

    if focus:
        elapsed = fmt_dur(focus["elapsed_seconds"])
        if focus["title"]:
            head = f'focus session on "{_trim(focus["title"], 60)}"'
        elif focus["promise_id"] is not None:
            head = "focus session on a commitment that no longer exists"
        else:
            head = "focus session with no target commitment"
        lines.append(f"- {head} — this run started {elapsed} ago")
        started = focus["started_at"]
        if started > summary["window_start"]:
            before = (started - summary["window_start"]).total_seconds()
            lines.append(
                f"  · the window below also covers {fmt_dur(before)} before it started"
            )

    app_line = _layer_line("apps", summary["apps"], with_titles=False, now=now)
    web_line = _layer_line("browsing", summary["browser"], with_titles=True, now=now)
    if app_line:
        lines.append(f"- {app_line}")
    if web_line:
        lines.append(f"- {web_line}")

    if summary["observed_seconds"] > 0:
        cov = summary["coverage"]
        lines.append(
            f"- sensors observed {fmt_dur(summary['observed_seconds'])} of the last "
            f"{summary['window_minutes']}m"
            + (f" (~{int(round(cov * 100))}% covered)" if cov is not None else "")
        )
    elif focus:
        # A live session with nothing observed is worth saying out loud — it is
        # the shape of an uninstalled extension or a closed laptop, and reading
        # it as "he did nothing" is exactly the wrong inference.
        lines.append("- no device activity recorded in this window (sensors may be off)")

    if summary["quiet_since"] is not None:
        reason = summary.get("quiet_reason")
        tail = " (screen went idle/locked)" if reason in _AWAY_REASONS else ""
        lines.append(
            f"- nothing observed since {fmt_age(summary['quiet_since'], now)}{tail}"
        )

    if summary["truncated_seconds"] > 0 or summary["capped"]:
        lines.append(
            "- some spans were salvaged or capped, so these durations are a floor"
        )

    if not lines:
        # Neither a live session nor anything either sensor observed in the
        # window — genuinely no signal, as opposed to a quiet-but-sensed
        # stretch (which the branches above already name). Say so explicitly:
        # a silently-omitted section reads to the model as "nothing to
        # report" and a truly dark sensor reads identically to a calm one.
        # The model should be able to tell "no data" apart from "idle".
        return ["no recent activity data"]

    return lines


def freshness_suffix(summary: dict) -> str | None:
    """The header's age label — `None` when the body already says "no data".

    Reads the freshest `last_end` across both layers: `as of {age}` under
    `STALE_THRESHOLD`, `stale — last data {age}` at or past it. Falls back to
    "as of now" when nothing was observed but a session is live (the session
    itself is the current signal), and to `None` — meaning no suffix, the
    caller renders the bare header — when there is truly nothing, since the
    body's "no recent activity data" line already carries that fact and
    repeating it in both places is noise, not clarity.
    """
    now = summary["window_end"]
    ends = [
        l["last_end"]
        for l in (summary["apps"], summary["browser"])
        if l.get("last_end") is not None
    ]
    if ends:
        newest = max(ends)
        age = now - newest
        if age < STALE_THRESHOLD:
            return f"as of {fmt_age(newest, now)}"
        return f"stale — last data {fmt_age(newest, now)}"
    if summary.get("focus"):
        return "as of now"
    return None


def build_activity_context(
    db: Session, *, window_minutes: int = WINDOW_MINUTES
) -> tuple[str | None, list[str]]:
    """`(header_suffix, lines)` — what Gooni should know about what Daniel is
    doing, plus the age label the header wears so stale data can't read as
    current. `header_suffix` is `None` exactly when `lines` already says "no
    recent activity data" on its own. Never raises.
    """
    try:
        summary = build_activity_summary(db, window_minutes=window_minutes)
        return freshness_suffix(summary), render_activity_lines(summary)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[activity_context] summary failed: {e}")
        return None, []


def build_activity_context_lines(
    db: Session, *, window_minutes: int = WINDOW_MINUTES
) -> list[str]:
    """What Gooni should know about what Daniel is doing, as state-block lines.

    Thin wrapper over `build_activity_context` for callers that only need the
    body (tests, mainly) — see that function for the header/freshness half.
    Never raises — the caller wraps this too, but a state-block surface that
    can take down a chat reply is a surface that eventually will.
    """
    _, lines = build_activity_context(db, window_minutes=window_minutes)
    return lines
