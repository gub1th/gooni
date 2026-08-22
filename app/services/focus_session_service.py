"""The focus session lifecycle, server-side.

`FocusSession` (see the model's docstring for WHY the row exists at all) is the
one place a sitting is started, paused, resumed and stopped. Every client —
the ambient home, `/focus`, Claude over MCP — drives the same four verbs here,
so there is exactly one implementation of every rule that used to live in a
browser tab and could be lost by closing it.

**What did NOT move.** Stopping still writes the `focus` TrackableEntry, one
per LOCAL calendar day, in exactly the `value_json` shape
`frontend/src/services/focusTime.ts` used to write and
`focus_attribution.parse_focus_entry` already reads. That entry is still the
durable record of the minutes; this module owns the lifecycle that produces it.
Two writers of one artifact is how a UI stop and an MCP stop would start
disagreeing, so the client's write path is gone rather than kept as a fallback.

**Three rules carried over verbatim, because each was earned:**

  1. **The 6h cap.** The feature's most common failure is the least dramatic
     one — a session left running overnight — and it would otherwise credit ~9h
     of sleep as focus against a Promise, making the primary output wrong. The
     open run is capped at `MAX_RUN_SEC` and the capped run is FLAGGED
     (`truncated`), never silently trimmed: a floor that says so is useful, a
     floor presented as a measurement is not. Server-side this is strictly
     better than it was in the client, because a closed tab can no longer leave
     an uncapped run accruing — `active()` closes a stale session on the next
     read.
  2. **Write, then clear.** `stop` writes the entries and only then marks the
     row stopped, inside one transaction. A stop that fails leaves the session
     PAUSED and retryable rather than destroying the only durable artifact the
     session produces.
  3. **Segments, not one stopwatch.** A pause splits the sitting, and "which
     windows did the sensors describe" is a question only the run list can
     answer. `focus_attribution` overlaps device intervals against exactly these
     windows, so their precision is the difference between "you were on it" and
     a guess.

**Camera control follows the session.** Every transition reconciles
`focus_cam_service.set_control` — start/resume → `running` with the promise as
the target, pause/stop → `idle`. Nothing should be sensed for a window that will
never be written. The frontend hook that used to own this still posts the same
values (belt-and-braces, and it is what covers a sidecar that was asleep at
click time), but it is no longer the only thing that knows.

Deterministic — no LLM anywhere in this module.
"""

from __future__ import annotations

import json
from datetime import date as _date
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..common import local_now
from ..db.models import FocusSession, Promise
from . import focus_session_activity

# The longest a single open run may claim, mirroring
# `useFocusSessionStore.MAX_RUN_MS` (6h) and the same ceiling
# `interval_ingest.MAX_INTERVAL_SEC` puts on a sensor interval.
MAX_RUN_SEC = 6 * 60 * 60

# Runs shorter than this are noise, not work — a click-through start/stop
# should not mint a segment. Same 1s floor the client store used.
MIN_RUN_SEC = 1.0

STATES = ("running", "paused", "stopped")
LIVE_STATES = ("running", "paused")

#: The one focus rollup's name. Must match `focus_attribution.FOCUS_TRACKABLE`
#: and `focusTime.ts::FOCUS_TRACKABLE` — one definition, get-or-created by name.
FOCUS_TRACKABLE = "focus"

VALID_STYLES = ("stopwatch", "timer")


# ── pure helpers ─────────────────────────────────────────────────────────────


def _utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    """Naive-UTC datetime → an ISO string that says so.

    The `+00:00` matters: the client parses these with `parseServerDate`, which
    only appends a zone when none is present, and `focus_attribution.parse_dt`
    reads either. Stamping the offset here means neither side has to guess.
    """
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt is not None else None


def _raw_segments_blob(s: FocusSession) -> list | dict:
    """Parse `s.segments` defensively, returning whatever JSON shape is
    stored (a bare list of runs, the legacy-only format, or the envelope
    dict below) — never raising. A malformed blob costs the run list rather
    than the read, the same contract `parse_focus_entry` applies."""
    if not s.segments:
        return []
    try:
        raw = json.loads(s.segments)
    except (TypeError, ValueError):
        return []
    if isinstance(raw, (list, dict)):
        return raw
    return []


def load_segments(s: FocusSession) -> list[dict]:
    """The CLOSED runs, defensively."""
    raw = _raw_segments_blob(s)
    items = raw.get("runs") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        start = _parse(item.get("start"))
        end = _parse(item.get("end"))
        if start is None or end is None or end <= start:
            continue
        out.append({"start": start, "end": end, "truncated": item.get("truncated") is True})
    out.sort(key=lambda r: r["start"])
    return out


def has_manual_title(s: FocusSession) -> bool:
    """Whether `s.title` was set by a human rename rather than snapshotted at
    start. Rides in the SAME free-form `segments` Text as the run list — no
    new column, same convention as `Settings.focus_cam`'s "shape grows
    without a migration" — because `s.segments` is otherwise never read
    outside this module (verified: nothing else touches `FocusSession.segments`),
    so widening its envelope from a bare list to `{"runs": [...],
    "manual_title": bool}` is safe. `serialize()` is the one reader that acts
    on this flag: a manually-set title must WIN over the linked Promise's
    live text, or a rename would be silently invisible the moment the
    commitment's own wording changes (the captain's explicit call — see
    `set_title`)."""
    raw = _raw_segments_blob(s)
    return isinstance(raw, dict) and raw.get("manual_title") is True


def _parse(raw) -> datetime | None:
    from .interval_ingest import parse_dt

    return parse_dt(raw)


def _dump_segments(runs: list[dict], *, manual_title: bool = False) -> str:
    """Serialize the run list, carrying `manual_title` forward as the
    envelope's own key so pause/resume/stop — which all overwrite
    `s.segments` with a fresh run list — can never silently drop a rename
    that happened earlier in the sitting. Every writer MUST read the flag
    off the row it is about to overwrite (`has_manual_title(s)`) before
    calling this, or a pause immediately after a rename would erase it."""
    runs_json = [
        {
            "start": _iso(r["start"]),
            "end": _iso(r["end"]),
            **({"truncated": True} if r.get("truncated") else {}),
        }
        for r in runs
    ]
    if not manual_title:
        # Plain list, unchanged from before this feature existed — a session
        # never renamed round-trips through the exact format it always did.
        return json.dumps(runs_json)
    return json.dumps({"runs": runs_json, "manual_title": True})


def sealed_runs(s: FocusSession, now: datetime | None = None) -> list[dict]:
    """Every focus run this session has accrued, INCLUDING the open one closed
    at `now` (or at the 6h cap, whichever comes first).

    The one closer. Both the write path and every read go through it, so the
    number on screen is the number that would be written if the session ended
    this instant — the same guarantee `sealedSegments` gave in the client.
    """
    now = now or _utcnow()
    runs = load_segments(s)
    if s.state != "running" or s.run_started_at is None:
        return runs
    start = s.run_started_at
    elapsed = (now - start).total_seconds()
    if elapsed < MIN_RUN_SEC:
        return runs
    if elapsed > MAX_RUN_SEC:
        # Nobody closed this. Credit the cap, and say so on the run.
        runs.append(
            {"start": start, "end": start + timedelta(seconds=MAX_RUN_SEC), "truncated": True}
        )
    else:
        runs.append({"start": start, "end": now, "truncated": False})
    runs.sort(key=lambda r: r["start"])
    return runs


def focused_seconds(runs: list[dict]) -> float:
    return sum((r["end"] - r["start"]).total_seconds() for r in runs)


def is_stale(s: FocusSession, now: datetime | None = None) -> bool:
    """A running session whose open run has already blown the cap. Nothing is
    accruing here any more — it just hasn't been told."""
    if s.state != "running" or s.run_started_at is None:
        return False
    return ((now or _utcnow()) - s.run_started_at).total_seconds() > MAX_RUN_SEC


def split_runs_by_day(runs: list[dict], tz) -> list[dict]:
    """Fold runs into one draft entry per LOCAL calendar day.

    The server-side twin of `focusTime.ts::splitSegmentsByDay`, and the reason
    it is a twin rather than a port: a session that runs past local midnight has
    to produce TWO entries or the daily fold lies about both days, and the day
    boundary has to be computed IN the zone per day (a DST switch inside a
    session moves one boundary by an hour — the same class of bug
    `local_day_bounds` exists to prevent).

    Returns `[{date, minutes, started_at, ended_at, segments, truncated}]`,
    matching what the client used to POST.
    """
    from ..common import local_day_bounds

    by_day: dict[_date, dict] = {}
    for run in runs:
        cursor = run["start"]
        end = run["end"]
        while cursor < end:
            day = cursor.replace(tzinfo=timezone.utc).astimezone(tz).date()
            _, day_end = local_day_bounds(tz, day)
            boundary = min(day_end, end)
            if boundary <= cursor:
                # Defensive: a zone whose bounds don't advance would spin here.
                break
            slot = by_day.setdefault(
                day,
                {"seconds": 0.0, "start": cursor, "end": boundary, "truncated": False, "runs": []},
            )
            slot["seconds"] += (boundary - cursor).total_seconds()
            slot["start"] = min(slot["start"], cursor)
            slot["end"] = max(slot["end"], boundary)
            slot["truncated"] = slot["truncated"] or run.get("truncated") is True
            slot["runs"].append((cursor, boundary))
            cursor = boundary

    drafts = []
    for day, slot in sorted(by_day.items()):
        minutes = round(slot["seconds"] / 60.0, 2)
        # A sub-second sliver either side of midnight isn't an entry.
        if minutes <= 0:
            continue
        drafts.append(
            {
                "date": day,
                "minutes": minutes,
                "started_at": _iso(slot["start"]),
                "ended_at": _iso(slot["end"]),
                # Sorted, because the attribution overlap short-circuits on the
                # first window starting past an interval's end.
                "segments": [
                    {"start": _iso(s), "end": _iso(e)}
                    for s, e in sorted(slot["runs"], key=lambda p: p[0])
                ],
                "truncated": slot["truncated"],
            }
        )
    return drafts


# ── camera control ───────────────────────────────────────────────────────────


def _reconcile_camera(db: Session, s: FocusSession | None) -> None:
    """Point the sidecar at what the session is doing. Best-effort by contract:
    a control write that fails must never turn a successful lifecycle
    transition into a reported error — the sidecar polls and self-heals, and the
    frontend hook posts the same value independently."""
    from . import focus_cam_service

    try:
        if s is not None and s.state == "running":
            focus_cam_service.set_control(db, "running", target_reminder_id=s.promise_id)
        else:
            focus_cam_service.set_control(db, "idle")
    except Exception as e:  # noqa: BLE001 — see docstring
        print(f"[focus_session] camera control reconcile failed: {e}")


# ── the write path ───────────────────────────────────────────────────────────


def _write_entries(db: Session, s: FocusSession, runs: list[dict]) -> list[dict]:
    """Write this session's minutes as `focus` TrackableEntry rows, one per
    local day.

    Deliberately the SAME shape the client wrote, including the traps that
    shape encodes:

      · NEVER `replace` — it would collapse the (trackable, day) and destroy
        every other session logged that day.
      · one entry per LOCAL day, or the daily fold lies about both.
      · `segments` carries the exact runs; `started_at`/`ended_at` are only the
        day's ENVELOPE, which spans any pause inside it.

    `session_id` is new and additive: a reader that wants the lifecycle row
    behind an entry can now find it, and nothing that already reads these
    entries cares about an extra key.
    """
    from . import trackable_service

    tz = local_now(db).tzinfo
    drafts = split_runs_by_day(runs, tz)
    if not drafts:
        return []

    t = trackable_service.create(
        db,
        name=FOCUS_TRACKABLE,
        kind="numeric",
        unit="minutes",
        agg="sum",
        source="derived",
        # parent_promise_id stays NULL: binding the DEFINITION to one Promise
        # would grow the log matrix a column per task. The promise id rides on
        # the ENTRY instead.
        schema_hint={"description": "focus session minutes (attribution on the entry)"},
    )

    # The "victory selfie" — whatever the sidecar's live preview last showed,
    # grabbed at the moment of stopping. It used to be the client's to attach;
    # it belongs with the write, and reading it here means an MCP stop gets one
    # too. Best-effort, and on the LAST day's entry only (the day the stop
    # actually happened on), so it can never be mistaken for a frame from an
    # earlier day of a multi-day session.
    frame = completion_frame(db)
    last_date = drafts[-1]["date"]

    written = []
    for d in drafts:
        trackable_service.log_entry(
            db,
            t,
            day=d["date"],
            value_numeric=d["minutes"],
            value_json={
                "promise_id": s.promise_id,
                "title": s.title,
                "started_at": d["started_at"],
                "ended_at": d["ended_at"],
                "segments": d["segments"],
                "session_id": s.id,
                **({"truncated": True} if d["truncated"] else {}),
                **({"completion_frame": frame} if frame and d["date"] == last_date else {}),
            },
            source="focus",
            # NO replace — see the docstring.
        )
        written.append({"date": d["date"].isoformat(), "minutes": d["minutes"]})
    return written


def completion_frame(db: Session) -> str | None:
    """The sidecar's latest preview frame as a data: URL, or None.

    A session ends successfully whether or not a frame was available, so every
    failure here is silent by design — the camera being off is the ordinary
    case, not an error.
    """
    try:
        from . import focus_cam_service

        blob = focus_cam_service.get_blob(db)
        b64 = blob.get("frame_b64")
        return f"data:image/jpeg;base64,{b64}" if b64 else None
    except Exception:  # noqa: BLE001 — see docstring
        return None


# ── lifecycle ────────────────────────────────────────────────────────────────


def active(db: Session, *, now: datetime | None = None) -> FocusSession | None:
    """The one running-or-paused session, or None.

    Also where a STALE session dies. The client could always be closed mid-run,
    and now that the row outlives the tab something has to notice: a running
    session past `MAX_RUN_SEC` is auto-stopped here (sealed at the cap, flagged
    `truncated`, its entries written, camera released) rather than being served
    as live. Read-triggered on purpose — every client polls this, so it fires
    within seconds of anyone looking, and a background sweep would be a second
    owner of the same rule.

    Defensive about duplicates: the invariant is one live session and `start`
    enforces it, but if two ever existed the newest wins and the rest are
    stopped rather than left to be picked up at random by the next read.
    """
    now = now or _utcnow()
    rows = (
        db.query(FocusSession)
        .filter(FocusSession.state.in_(LIVE_STATES))
        .order_by(FocusSession.started_at.desc(), FocusSession.id.desc())
        .all()
    )
    if not rows:
        return None

    live = rows[0]
    for extra in rows[1:]:
        print(f"[focus_session] stopping orphaned live session {extra.id}")
        stop(db, extra, now=now)

    if is_stale(live, now):
        print(
            f"[focus_session] session {live.id} ran past MAX_RUN_SEC "
            f"({MAX_RUN_SEC}s) — auto-stopping, its minutes are a FLOOR"
        )
        stop(db, live, now=now)
        return None
    return live


def get(db: Session, session_id: int) -> FocusSession | None:
    return db.query(FocusSession).filter(FocusSession.id == session_id).first()


def recent(db: Session, *, limit: int = 20) -> list[FocusSession]:
    return (
        db.query(FocusSession)
        .order_by(FocusSession.started_at.desc(), FocusSession.id.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )


def start(
    db: Session,
    *,
    title: str,
    promise_id: int | None = None,
    style: str = "stopwatch",
    target_ms: int | None = None,
    now: datetime | None = None,
) -> FocusSession:
    """Start a session, ending whatever was running first.

    The switch is CONDITIONAL on the outgoing session's entries landing —
    `stop` raises if the write fails, which aborts the start and leaves the old
    session paused and recoverable rather than swapping it away with its minutes
    unwritten. Same rule `switchFocusSession` enforced client-side, now in the
    one place both a UI click and an MCP call go through.
    """
    now = now or _utcnow()
    title = (title or "").strip()
    if not title:
        raise ValueError("title required")
    style = (style or "stopwatch").strip().lower()
    if style not in VALID_STYLES:
        raise ValueError(f"style must be one of {VALID_STYLES}")

    prior = active(db, now=now)
    if prior is not None:
        # Re-starting the task already running would throw its segments away and
        # zero the clock. Nothing legitimately wants that.
        if promise_id is not None and prior.promise_id == promise_id:
            return prior
        stop(db, prior, now=now)

    s = FocusSession(
        promise_id=promise_id,
        title=title,
        state="running",
        started_at=now,
        run_started_at=now,
        total_paused_ms=0,
        segments="[]",
        truncated=False,
        style=style,
        target_ms=int(target_ms) if target_ms else None,
        kept=False,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    _reconcile_camera(db, s)
    return s


def pause(db: Session, s: FocusSession, *, now: datetime | None = None) -> FocusSession:
    """Close the open run and hold. Idempotent — pausing a paused session is a
    no-op rather than a second (empty) run."""
    now = now or _utcnow()
    if s.state != "running":
        return s
    manual_title = has_manual_title(s)
    runs = sealed_runs(s, now)
    s.segments = _dump_segments(runs, manual_title=manual_title)
    s.truncated = s.truncated or any(r.get("truncated") for r in runs)
    s.state = "paused"
    s.paused_at = now
    s.run_started_at = None
    db.commit()
    db.refresh(s)
    _reconcile_camera(db, s)
    return s


def resume(db: Session, s: FocusSession, *, now: datetime | None = None) -> FocusSession:
    """Open a new run. The pause that just ended is folded into
    `total_paused_ms` in this same transition, which is what keeps that scalar
    and the run list from ever disagreeing."""
    now = now or _utcnow()
    if s.state != "paused":
        return s
    if s.paused_at is not None:
        s.total_paused_ms = int(s.total_paused_ms or 0) + int(
            max(0.0, (now - s.paused_at).total_seconds()) * 1000
        )
    s.state = "running"
    s.run_started_at = now
    s.paused_at = None
    db.commit()
    db.refresh(s)
    _reconcile_camera(db, s)
    return s


def stop(db: Session, s: FocusSession, *, now: datetime | None = None) -> FocusSession:
    """End the session: seal it, WRITE its entries, and only then mark it
    stopped.

    Ordering is the whole rule. The entry is the only durable artifact a session
    produces, so a failed write must leave the row live (paused, with its runs
    intact) and retryable — never stopped with the minutes gone. Idempotent:
    stopping an already-stopped session returns it untouched rather than writing
    its minutes a second time onto a `sum`-agg trackable.
    """
    now = now or _utcnow()
    if s.state == "stopped":
        return s

    manual_title = has_manual_title(s)
    runs = sealed_runs(s, now)
    # Seal FIRST, in memory, so a write failure below leaves a paused session
    # holding exactly these runs rather than a still-open one that would seal
    # longer on the retry.
    s.segments = _dump_segments(runs, manual_title=manual_title)
    s.truncated = s.truncated or any(r.get("truncated") for r in runs)
    if s.state == "paused" and s.paused_at is not None:
        s.total_paused_ms = int(s.total_paused_ms or 0) + int(
            max(0.0, (now - s.paused_at).total_seconds()) * 1000
        )
    s.state = "paused"
    s.paused_at = now
    s.run_started_at = None
    db.commit()

    _write_entries(db, s, runs)

    s.state = "stopped"
    s.ended_at = now
    s.paused_at = None
    db.commit()
    db.refresh(s)
    _reconcile_camera(db, None)
    return s


def set_style(
    db: Session, s: FocusSession, *, style: str | None = None, target_ms: int | None = None
) -> FocusSession:
    """Switching how the session is TIMED does not touch its runs — stopwatch
    and timer accrue identically and differ only in how the same elapsed time is
    displayed."""
    if style is not None:
        style = style.strip().lower()
        if style not in VALID_STYLES:
            raise ValueError(f"style must be one of {VALID_STYLES}")
        s.style = style
    if target_ms is not None:
        s.target_ms = int(target_ms) if int(target_ms) > 0 else None
    db.commit()
    db.refresh(s)
    return s


def set_kept(db: Session, s: FocusSession, kept: bool) -> FocusSession:
    s.kept = bool(kept)
    db.commit()
    db.refresh(s)
    return s


def set_title(db: Session, s: FocusSession, title: str) -> FocusSession:
    """A human rename. Captain's explicit call: it must WIN over the linked
    Promise's live text (`serialize()` normally prefers that, so a
    commitment renamed after the session started still shows correctly) —
    renaming the session is not the same act as renaming the commitment, and
    a naive title write would otherwise be silently invisible the instant
    `serialize()` next ran. Marks `manual_title` in the same `segments`
    envelope `_dump_segments` writes (see `has_manual_title`); every later
    pause/stop already reads that flag back before it overwrites the
    envelope, so the rename survives the rest of the sitting. Does NOT touch
    the underlying Promise — only this session's own label."""
    title = (title or "").strip()
    if not title:
        raise ValueError("title required")
    s.title = title
    s.segments = _dump_segments(load_segments(s), manual_title=True)
    db.commit()
    db.refresh(s)
    return s


# ── serialization ────────────────────────────────────────────────────────────


def activity(db: Session, s: FocusSession, *, now: datetime | None = None) -> dict:
    """What the sensors saw during this session — `focus_session_activity`
    called with THIS session's window and its exact runs.

    The one place a `FocusSession` is translated into that module's
    (since, until, runs) vocabulary, so the route, the stop response and the MCP
    tool cannot each pick a slightly different window. The window is the whole
    sitting (the sensors were watching through the pauses too); the RUNS are
    what the score is computed over, because a pause is real elapsed time the
    session was not claiming.
    """
    now = now or _utcnow()
    runs = sealed_runs(s, now)
    since = runs[0]["start"] if runs else s.started_at
    until = s.ended_at or (max(r["end"] for r in runs) if runs else now)
    return focus_session_activity.session_activity(
        db,
        since=since,
        until=max(until, since),
        runs=[(r["start"], r["end"]) for r in runs],
        session_id=s.id,
    )


def serialize(db: Session, s: FocusSession, *, now: datetime | None = None) -> dict:
    """The session as every client sees it.

    `focused_ms` is sealed at `now` through the SAME closer the write path uses,
    so a client rendering it is rendering what would be stored — not a second
    arithmetic that can drift from the first.
    """
    now = now or _utcnow()
    runs = sealed_runs(s, now)
    title = s.title
    # A manual rename WINS over the live Promise text — the captain's explicit
    # call (see `set_title`). Without this branch, the override two lines
    # below would silently swallow every rename the instant the promise's own
    # wording next changed, which is exactly the bug this feature exists to
    # avoid.
    if s.promise_id is not None and not has_manual_title(s):
        p = db.query(Promise).filter(Promise.id == s.promise_id).first()
        if p is not None:
            # Live promise text beats the snapshot: a commitment renamed since
            # the session started would otherwise show under its old name.
            title = (p.summary or p.utterance or s.title).strip() or s.title
    return {
        "id": s.id,
        "promise_id": s.promise_id,
        "title": title,
        "title_is_manual": has_manual_title(s),
        "state": s.state,
        "started_at": _iso(s.started_at),
        "ended_at": _iso(s.ended_at),
        "run_started_at": _iso(s.run_started_at),
        "paused_at": _iso(s.paused_at),
        "total_paused_ms": int(s.total_paused_ms or 0),
        "focused_ms": int(focused_seconds(runs) * 1000),
        "focused_minutes": round(focused_seconds(runs) / 60.0, 2),
        "segments": [
            {"start": _iso(r["start"]), "end": _iso(r["end"]), "truncated": bool(r.get("truncated"))}
            for r in runs
        ],
        "truncated": bool(s.truncated) or any(r.get("truncated") for r in runs),
        "style": s.style,
        "target_ms": s.target_ms,
        "kept": bool(s.kept),
    }
