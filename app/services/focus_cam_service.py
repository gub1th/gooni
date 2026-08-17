"""Focus-cam brain side — persistence + serving for the local webcam focus
sidecar.

A macOS sidecar (built separately) watches the webcam, computes focus signals,
and reports up to Gooni over Bearer-authed HTTP (Gooni on fly.io can't reach
into the home NAT, so ALL traffic is sidecar-initiated / polling):

  · live state       → merged into the Settings.focus_cam JSON blob (latest-wins)
  · desired control  → the same blob (a UI Start/Stop button sets it; the sidecar
                       polls + reconciles — self-healing if it was asleep at click)
  · discrete events  → +1 on a "focus {kind}" sum-agg numeric Trackable
  · session summaries→ one rich json Trackable entry per session

Storage maps ONTO existing primitives (no new tables beyond the one Settings
column) — every Trackable + entry carries source="focus_cam", which the shared
read paths (matrix/dots/rail/overlay/chat) exclude via trackable_service.
HIDDEN_SOURCES. Focus data is read ONLY here + the /focus/cam surface.

Deterministic — no LLM. tz parsing reuses event_service._parse_at (THE event
timestamp parser); calendar days resolve via local_now/local_today.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..common import local_now
from ..deps import _settings_row
from . import trackable_service
from .event_service import _parse_at  # reuse THE event-timestamp parser

SOURCE = "focus_cam"

VALID_STATES = ("focused", "distracted", "away", "paused")
VALID_CONTROLS = ("idle", "running")
VALID_EVENT_KINDS = ("distracted", "phone", "vape", "stand", "left_desk")
# Kinds that count as a VIOLATION for the status indicator's live count —
# `stand` isn't a lapse, so it's excluded (left_desk isn't either, same reason).
VIOLATION_EVENT_KINDS = ("distracted", "phone", "vape")

SESSION_TRACKABLE = "focus_session"
SCORE_TRACKABLE = "focus_score"
EVIDENCE_TRACKABLE = "focus_evidence"
# One entry per camera state CHANGE — the history the blob deliberately doesn't
# keep. See `log_state_change`.
STATE_TRACKABLE = "focus_state"

_DEFAULT_BLOB = {
    "control": "idle",
    "state": None,
    "score": None,
    "app": None,
    # Which physical camera the sidecar is reading from (e.g. "FaceTime HD
    # Camera") — display-only, so the status indicator can name it rather than
    # just claiming "camera" generically.
    "camera": None,
    "session_id": None,
    "at": None,
    # The short-term promise this session is FOR (focus_service Reminder id), set
    # by the dashboard's per-promise ▶ focus control. None = an untargeted block.
    "target_reminder_id": None,
    # When the CURRENT focus run started, stamped server-side (naive UTC ISO) on
    # the transition into `running`. The client never sends it — see set_control.
    "control_at": None,
}


# ── control + live state (Settings.focus_cam blob) ───────────────────────────


def get_blob(db: Session) -> dict:
    """Current focus_cam blob. Missing/blank/corrupt → the idle default (a bad
    write must never brick the sidecar's control read)."""
    s = _settings_row(db)
    if not s.focus_cam:
        return dict(_DEFAULT_BLOB)
    try:
        stored = json.loads(s.focus_cam)
    except (TypeError, ValueError):
        return dict(_DEFAULT_BLOB)
    if not isinstance(stored, dict):
        return dict(_DEFAULT_BLOB)
    blob = dict(_DEFAULT_BLOB)
    blob.update(stored)
    return blob


def _write_blob(db: Session, blob: dict) -> dict:
    s = _settings_row(db)
    s.focus_cam = json.dumps(blob)
    db.commit()
    return blob


def merge_state(
    db: Session,
    *,
    session_id: str | None,
    at: str | None,
    state: str | None,
    score: float | None,
    app: str | None,
    camera: str | None = None,
) -> dict:
    """Merge one live-state report into the blob (control is left untouched —
    the sidecar reports state, the UI owns control).

    Also APPENDS to the state history when the state actually changed — see
    `log_state_change`. The sidecar's contract is untouched: same body, same
    response, same cadence. What changed is that the blob is no longer the only
    thing that remembers, because a latest-wins blob cannot answer "what was the
    camera seeing between 14:05 and 14:30", which is the whole basis of a
    session's focus score.
    """
    blob = get_blob(db)
    previous = blob.get("state")
    if state is not None:
        blob["state"] = state if state in VALID_STATES else blob.get("state")
    blob["score"] = float(score) if score is not None else score
    blob["app"] = app
    if camera is not None:
        blob["camera"] = camera
    blob["session_id"] = session_id
    blob["at"] = at
    written = _write_blob(db, blob)

    if blob.get("state") != previous and blob.get("state") in VALID_STATES:
        log_state_change(
            db,
            session_id=session_id,
            state=blob["state"],
            at=at,
            score=score,
            app=app,
        )
    return written


def log_state_change(
    db: Session,
    *,
    session_id: str | None,
    state: str,
    at: str | None,
    score: float | None = None,
    app: str | None = None,
) -> None:
    """Append one camera state CHANGE to the history.

    A json Trackable entry rather than a table, for the same reason every other
    focus-cam artifact is one: storage maps onto existing primitives, the row is
    walled off behind `source="focus_cam"`, and `value_json` grows without a
    migration. One entry per CHANGE, never per keepalive — the sidecar posts a
    ~30s heartbeat and storing those would be ~3k rows a day to answer a
    question a dozen transitions already answer.

    Best-effort by contract: the state POST must keep succeeding whether or not
    the history write does. Losing a transition costs precision in one session's
    score; failing the POST costs the sidecar's live state entirely.
    """
    try:
        now_local = local_now(db)
        when = _parse_at(at, now_local)
        day = when.astimezone(now_local.tzinfo).date()
        t = trackable_service.create(
            db,
            name=STATE_TRACKABLE,
            kind="json",
            agg="last",
            source=SOURCE,
            schema_hint={"description": "focus-cam state transitions (webcam sidecar)"},
        )
        trackable_service.log_entry(
            db,
            t,
            day=day,
            value_json={
                "state": state,
                "at": when.isoformat(),
                "session_id": session_id,
                "score": score,
                "app": app,
            },
            source=SOURCE,
        )
    except Exception as e:  # noqa: BLE001 — see docstring
        print(f"[focus_cam] state-history write failed: {e}")


def set_control(db: Session, control: str, target_reminder_id: int | None = None) -> dict:
    """Set desired control (the reconcile target the sidecar polls). Only
    control + target change; live-state fields are preserved.

    `target_reminder_id` binds the session to ONE short-term promise (the
    dashboard's `▶ focus` control). It's what lets the post-session report say
    *what* you focused on and offer to mark that promise kept, instead of
    reporting an anonymous block of time. Starting a session always rewrites the
    target (including to None); stopping clears it, since a target outliving its
    session would mislabel the next one.

    **`control_at` is stamped HERE, on the transition into running**, and is the
    only server-visible answer to "how long has this run been going" — the
    session itself is a client store (`useFocusSessionStore`), so nothing else
    server-side knows a session exists. Two rules make it honest:

      · stamped on the TRANSITION, not on every post. `useFocusCamControl` fires
        its effect on mount, so a page reload mid-session re-posts `running` with
        the same target; re-stamping there would reset a two-hour run to zero on
        a refresh. An unchanged (control, target) pair keeps the original stamp.
      · cleared with the control. A run that has stopped has no start, and a
        stamp outliving its session is exactly the stale claim
        `activity_context.live_focus_session` refuses to report on.
    """
    if control not in VALID_CONTROLS:
        raise ValueError(f"control must be one of {VALID_CONTROLS}")
    blob = get_blob(db)
    target = target_reminder_id if control == "running" else None
    resumed = control == "running" and (
        blob.get("control") != "running"
        or blob.get("target_reminder_id") != target
        or not blob.get("control_at")
    )
    blob["control"] = control
    blob["target_reminder_id"] = target
    if control != "running":
        blob["control_at"] = None
    elif resumed:
        blob["control_at"] = datetime.utcnow().isoformat()
    return _write_blob(db, blob)


def set_frame(
    db: Session,
    *,
    session_id: str | None,
    at: str | None,
    state: str | None,
    jpeg_b64: str,
) -> dict:
    """Store the LATEST preview thumbnail (overwrite, no history) folded into the
    same blob. A low-res live frame is the widget's proof a sidecar is actually
    alive — freshness = liveness. The raw base64 rides in `frame_b64`; the public
    read (get_public_blob) expands it to a data: URL so the widget stays a dumb
    <img src>. Kept out of _DEFAULT_BLOB so a frameless blob carries no bloat;
    get_blob preserves the key across state/control writes."""
    blob = get_blob(db)
    blob["frame_b64"] = jpeg_b64
    blob["frame_at"] = at
    # Only accept a known state (or null); a garbage value keeps the last.
    if state is None or state in VALID_STATES:
        blob["frame_state"] = state
    blob["frame_session"] = session_id
    return _write_blob(db, blob)


def get_public_blob(db: Session) -> dict:
    """The GET /focus/cam response: the control+state blob with the raw stored
    frame expanded into a `frame` data: URL + `frame_at` (the two fields the
    widget renders). The internal `frame_b64`/`frame_state`/`frame_session`
    storage keys are stripped — callers see only presentation-ready fields."""
    blob = get_blob(db)
    b64 = blob.pop("frame_b64", None)
    frame_at = blob.pop("frame_at", None)
    blob.pop("frame_state", None)
    blob.pop("frame_session", None)
    blob["frame"] = f"data:image/jpeg;base64,{b64}" if b64 else None
    blob["frame_at"] = frame_at
    return blob


# ── discrete events + session summaries (Trackables) ─────────────────────────


def log_event(
    db: Session,
    *,
    session_id: str | None,
    kind: str,
    started_at: str | None,
    ended_at: str | None = None,
    duration_sec: int | None = None,
    activity: str | None = None,
    evidence_id: str | None = None,
) -> dict:
    """+1 on the "focus {kind}" sum-agg numeric Trackable, on the LOCAL day of
    `started_at`. The clock time + optional dwell/activity/evidence ride in
    value_json (a loose escape-hatch — future fields need no schema change).
    Returns the day's running count."""
    if kind not in VALID_EVENT_KINDS:
        raise ValueError(f"kind must be one of {VALID_EVENT_KINDS}")

    now_local = local_now(db)
    when = _parse_at(started_at, now_local)
    day = when.astimezone(now_local.tzinfo).date()

    name = f"focus {kind}"
    t = trackable_service.create(
        db,
        name=name,
        kind="numeric",
        agg="sum",
        source=SOURCE,
        schema_hint={"description": f"focus-cam '{kind}' events (webcam sidecar)"},
    )
    trackable_service.log_entry(
        db,
        t,
        day=day,
        value_numeric=1.0,
        value_json={
            "at": when.isoformat(),
            "session_id": session_id,
            "duration_sec": duration_sec,
            "activity": activity,
            "evidence_id": evidence_id,
        },
        source=SOURCE,
    )
    entries = trackable_service.entries_for(db, t, start=day, end=day)
    count = trackable_service.day_value(entries, t) or 0
    return {"ok": True, "count": int(count)}


def log_session(db: Session, body: dict) -> dict:
    """Record a finished session as one json Trackable entry on the LOCAL day of
    `ended_at`, storing the entire report in value_json. Also mirrors
    `focus_score` to a numeric Trackable (same day) for future charting.

    The session inherits the blob's `target_reminder_id` (the promise the UI was
    focusing on) unless the sidecar named one itself. Stamping it HERE rather
    than trusting the sidecar keeps the binding correct even for a sidecar that
    predates the field — it reads control and never has to know about promises.
    """
    now_local = local_now(db)
    ended = _parse_at(body.get("ended_at"), now_local)
    day = ended.astimezone(now_local.tzinfo).date()

    body = dict(body)
    if body.get("target_reminder_id") is None:
        body["target_reminder_id"] = get_blob(db).get("target_reminder_id")

    sess = trackable_service.create(
        db,
        name=SESSION_TRACKABLE,
        kind="json",
        agg="last",
        source=SOURCE,
        schema_hint={"description": "focus-cam per-session summary (webcam sidecar)"},
    )
    entry = trackable_service.log_entry(
        db,
        sess,
        day=day,
        value_json=body,
        source=SOURCE,
    )

    score = body.get("focus_score")
    if score is not None:
        mirror = trackable_service.create(
            db,
            name=SCORE_TRACKABLE,
            kind="numeric",
            agg="last",
            source=SOURCE,
            schema_hint={"description": "focus-cam daily focus score mirror"},
        )
        trackable_service.log_entry(
            db,
            mirror,
            day=day,
            value_numeric=float(score),
            value_json={"session_id": body.get("session_id")},
            source=SOURCE,
        )

    return {"ok": True, "entry_id": entry.id if entry else None}


#: How far BEFORE a window to look for the transition that set the state at its
#: left edge. A camera state persists until the next change, so the row that
#: describes 14:05 may have been written at 13:40 — or at 09:00 on a quiet
#: morning. Bounded, because an unbounded look-back would scan the whole table
#: to answer a question about half an hour; a window whose opening state cannot
#: be found reads as UNOBSERVED, which is the honest answer rather than a
#: guessed one.
STATE_LOOKBACK_DAYS = 2


def state_history(db: Session, *, start: datetime, end: datetime) -> list[dict]:
    """Camera state transitions in `[start, end)`, plus the one in effect AT
    `start`, as `[{at, state}]` in naive UTC, oldest first.

    The prior transition is included (stamped at `start`) because a state is a
    span, not a point: without it a session that began mid-`focused` would read
    as unobserved until the camera happened to change its mind.
    """
    t = trackable_service.get_by_name(db, STATE_TRACKABLE)
    if t is None:
        return []
    tz = local_now(db).tzinfo
    start_day = (start.replace(tzinfo=timezone.utc).astimezone(tz).date()) - timedelta(
        days=STATE_LOOKBACK_DAYS
    )
    end_day = end.replace(tzinfo=timezone.utc).astimezone(tz).date()

    rows = trackable_service.entries_for(db, t, start=start_day, end=end_day)
    parsed: list[tuple[datetime, str]] = []
    for e in rows:
        payload = trackable_service.serialize_entry(e)["value_json"]
        if not isinstance(payload, dict):
            continue
        state = payload.get("state")
        if state not in VALID_STATES:
            continue
        when = _to_naive_utc(payload.get("at"))
        if when is None:
            continue
        parsed.append((when, state))
    parsed.sort(key=lambda p: p[0])

    out: list[dict] = []
    opening: str | None = None
    for when, state in parsed:
        if when < start:
            opening = state
            continue
        if when >= end:
            break
        out.append({"at": when, "state": state})
    if opening is not None:
        out.insert(0, {"at": start, "state": opening})
    return out


def last_report_at(db: Session) -> datetime | None:
    """When the sidecar last said ANYTHING, as naive UTC — the blob's `at`.

    The liveness signal this module already leans on ("freshness = liveness"),
    read here so a session's score can stop crediting a camera that stopped
    looking. None when nothing has ever reported, which callers must treat as
    "no bound available" rather than as "reported at the epoch".
    """
    return _to_naive_utc(get_blob(db).get("at"))


def _to_naive_utc(raw) -> datetime | None:
    """One stored `value_json.at` → the naive-UTC storage convention.

    Delegates to `interval_ingest.parse_dt`, THE parser for "a client wrote a
    timestamp and we store naive UTC" — a second implementation here is exactly
    how two readers of the same column start disagreeing about an hour.
    """
    from .interval_ingest import parse_dt

    return parse_dt(raw)


def events_in_range(db: Session, *, start: datetime, end: datetime) -> list[dict]:
    """Discrete camera events (`focus {kind}`) whose clock time falls in
    `[start, end)`, oldest first.

    Day-bounded prefilter on the entry's indexed `date` column, exact
    containment after parsing — the same two-step `focus_attribution.
    _shortcuts_events` uses, and for the same reason (the clock time lives in
    unindexed `value_json`).
    """
    tz = local_now(db).tzinfo
    start_day = start.replace(tzinfo=timezone.utc).astimezone(tz).date() - timedelta(days=1)
    end_day = end.replace(tzinfo=timezone.utc).astimezone(tz).date() + timedelta(days=1)

    out: list[dict] = []
    for kind in VALID_EVENT_KINDS:
        t = trackable_service.get_by_name(db, f"focus {kind}")
        if t is None:
            continue
        for e in trackable_service.entries_for(db, t, start=start_day, end=end_day):
            payload = trackable_service.serialize_entry(e)["value_json"]
            if not isinstance(payload, dict):
                continue
            when = _to_naive_utc(payload.get("at"))
            if when is None or when < start or when >= end:
                continue
            out.append(
                {
                    "kind": kind,
                    "at": when,
                    "duration_sec": payload.get("duration_sec"),
                    "activity": payload.get("activity"),
                    "session_id": payload.get("session_id"),
                }
            )
    out.sort(key=lambda r: r["at"])
    return out


def evidence_in_range(db: Session, *, start: datetime, end: datetime, limit: int = 60) -> list[dict]:
    """Evidence frames whose clock time falls in `[start, end)`, newest first."""
    t = trackable_service.get_by_name(db, EVIDENCE_TRACKABLE)
    if t is None:
        return []
    tz = local_now(db).tzinfo
    start_day = start.replace(tzinfo=timezone.utc).astimezone(tz).date() - timedelta(days=1)
    end_day = end.replace(tzinfo=timezone.utc).astimezone(tz).date() + timedelta(days=1)

    out: list[dict] = []
    for e in trackable_service.entries_for(db, t, start=start_day, end=end_day):
        payload = trackable_service.serialize_entry(e)["value_json"]
        if not isinstance(payload, dict):
            continue
        when = _to_naive_utc(payload.get("at"))
        if when is None or when < start or when >= end:
            continue
        jpeg_b64 = payload.get("jpeg_b64")
        out.append(
            {
                "id": e.id,
                "kind": payload.get("kind"),
                "at": when.replace(tzinfo=timezone.utc).isoformat(),
                "activity": payload.get("activity"),
                "frame": f"data:image/jpeg;base64,{jpeg_b64}" if jpeg_b64 else None,
            }
        )
    out.sort(key=lambda r: r["at"], reverse=True)
    return out[:limit]


def today_summary(db: Session) -> dict:
    """The focus widget's read: today's sessions (full payloads) + today's
    per-kind event counts. Read by name/source HERE — never via the walled-off
    generic trackable list."""
    today = local_now(db).date()

    sessions: list[dict] = []
    sess_t = trackable_service.get_by_name(db, SESSION_TRACKABLE)
    if sess_t is not None:
        for e in trackable_service.entries_for(db, sess_t, start=today, end=today):
            payload = trackable_service.serialize_entry(e)["value_json"]
            if payload is not None:
                sessions.append(payload)

    events: dict[str, int] = {}
    for kind in VALID_EVENT_KINDS:
        t = trackable_service.get_by_name(db, f"focus {kind}")
        if t is None:
            continue
        entries = trackable_service.entries_for(db, t, start=today, end=today)
        count = trackable_service.day_value(entries, t) or 0
        if count:
            events[kind] = int(count)

    return {"date": today.isoformat(), "sessions": sessions, "events": events}


# ── evidence frames (gallery) ─────────────────────────────────────────────────
#
# The `frame` blob field is LATEST-ONLY liveness — no history, gone the moment
# the next one lands. A gallery needs the opposite: a handful of frames worth
# looking back at, kept only when something happened. So a DETECTED frame
# (phone/vape/distracted — see VALID_EVENT_KINDS) is its own json Trackable
# entry, one per evidence shot, same "value_json holds the whole thing" pattern
# `log_session` already uses. Not every frame — an evidence-only gallery is
# what makes it worth glancing at; a frame per ~10s tick would be a filmstrip
# nobody scrubs.


def log_evidence(
    db: Session,
    *,
    session_id: str | None,
    kind: str,
    started_at: str | None,
    jpeg_b64: str,
    activity: str | None = None,
    evidence_id: str | None = None,
) -> dict:
    """Persist one evidence frame, keyed to the detection that triggered it."""
    if kind not in VALID_EVENT_KINDS:
        raise ValueError(f"kind must be one of {VALID_EVENT_KINDS}")

    now_local = local_now(db)
    when = _parse_at(started_at, now_local)
    day = when.astimezone(now_local.tzinfo).date()

    t = trackable_service.create(
        db,
        name=EVIDENCE_TRACKABLE,
        kind="json",
        agg="last",
        source=SOURCE,
        schema_hint={"description": "focus-cam evidence frames (webcam sidecar)"},
    )
    entry = trackable_service.log_entry(
        db,
        t,
        day=day,
        value_json={
            "kind": kind,
            "at": when.isoformat(),
            "session_id": session_id,
            "activity": activity,
            "evidence_id": evidence_id,
            "jpeg_b64": jpeg_b64,
        },
        source=SOURCE,
    )
    return {"ok": True, "id": entry.id if entry else None}


def recent_evidence(db: Session, *, limit: int = 20, days_back: int = 3) -> list[dict]:
    """The gallery read: the most recent evidence frames, newest first.

    Scans a bounded window of local days rather than the whole table — evidence
    is meant to be glanced at during/right after a session, not archived. Folded
    in Python (not SQL) because the payload — including the frame bytes — lives
    in unindexed `value_json`, same tradeoff `minutesByPromise` already makes on
    this table family.
    """
    t = trackable_service.get_by_name(db, EVIDENCE_TRACKABLE)
    if t is None:
        return []
    today = local_now(db).date()
    start = today - timedelta(days=max(days_back - 1, 0))
    entries = trackable_service.entries_for(db, t, start=start, end=today)
    entries.sort(key=lambda e: (e.date, e.created_at, e.id), reverse=True)

    out: list[dict] = []
    for e in entries[:limit]:
        payload = trackable_service.serialize_entry(e)["value_json"]
        if not isinstance(payload, dict):
            continue
        jpeg_b64 = payload.get("jpeg_b64")
        out.append(
            {
                "id": e.id,
                "kind": payload.get("kind"),
                "at": payload.get("at"),
                "session_id": payload.get("session_id"),
                "activity": payload.get("activity"),
                "frame": f"data:image/jpeg;base64,{jpeg_b64}" if jpeg_b64 else None,
            }
        )
    return out
