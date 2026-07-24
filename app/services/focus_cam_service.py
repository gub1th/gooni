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
from datetime import datetime

from sqlalchemy.orm import Session

from ..common import local_now
from ..deps import _settings_row
from . import trackable_service
from .event_service import _parse_at  # reuse THE event-timestamp parser

SOURCE = "focus_cam"

VALID_STATES = ("focused", "distracted", "away", "paused")
VALID_CONTROLS = ("idle", "running")
VALID_EVENT_KINDS = ("distracted", "phone", "vape", "stand", "left_desk")

SESSION_TRACKABLE = "focus_session"
SCORE_TRACKABLE = "focus_score"

_DEFAULT_BLOB = {
    "control": "idle",
    "state": None,
    "score": None,
    "app": None,
    "session_id": None,
    "at": None,
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
) -> dict:
    """Merge one live-state report into the blob (control is left untouched —
    the sidecar reports state, the UI owns control)."""
    blob = get_blob(db)
    if state is not None:
        blob["state"] = state if state in VALID_STATES else blob.get("state")
    blob["score"] = float(score) if score is not None else score
    blob["app"] = app
    blob["session_id"] = session_id
    blob["at"] = at
    return _write_blob(db, blob)


def set_control(db: Session, control: str) -> dict:
    """Set desired control (the reconcile target the sidecar polls). Only
    control changes; live-state fields are preserved."""
    if control not in VALID_CONTROLS:
        raise ValueError(f"control must be one of {VALID_CONTROLS}")
    blob = get_blob(db)
    blob["control"] = control
    return _write_blob(db, blob)


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
    `focus_score` to a numeric Trackable (same day) for future charting."""
    now_local = local_now(db)
    ended = _parse_at(body.get("ended_at"), now_local)
    day = ended.astimezone(now_local.tzinfo).date()

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
