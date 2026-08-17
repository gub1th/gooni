"""Focus session lifecycle routes. Bearer-authed by the global middleware.

  POST  /focus/sessions              → create & start (ends whatever ran before)
  GET   /focus/sessions/active       → the running/paused session, or null
  GET   /focus/sessions              → recent sessions, newest first
  GET   /focus/sessions/{id}         → one session, with its computed stats
  GET   /focus/sessions/{id}/activity→ everything the sensors saw in its window
  PATCH /focus/sessions/{id}         → style / target_ms / kept
  POST  /focus/sessions/{id}/pause   → close the open run and hold
  POST  /focus/sessions/{id}/resume  → open a new run
  POST  /focus/sessions/{id}/stop    → seal, WRITE the entries, end

Namespaced under /focus/sessions/* — clear of /focus/cam/* (the webcam
sidecar's surface, which has its own unrelated `POST /focus/cam/sessions`) and
of the Focus SYSTEM's /focus/{thoughts,topics,reminders}.

`/focus/sessions/active` is declared BEFORE `/focus/sessions/{session_id}` on
purpose: FastAPI matches in declaration order, so the reverse would try to parse
"active" as an int and 422 the one read every client polls.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import focus_session_service

router = APIRouter()


def _payload(db: Session, s, *, with_activity: bool = False) -> dict:
    out = focus_session_service.serialize(db, s)
    if with_activity:
        out["activity"] = focus_session_service.activity(db, s)
    return out


def _require(db: Session, session_id: int):
    s = focus_session_service.get(db, session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")
    return s


@router.post("/focus/sessions")
def create_focus_session(body: dict, db: Session = Depends(get_db)):
    """Start a session. `{title, promise_id?, style?, target_ms?}`.

    Ending whatever was running first is part of STARTING, not a separate call:
    the outgoing session's entries must land before the new one replaces it, and
    a client that has to remember to sequence two calls is a client that will
    eventually lose a session's minutes.
    """
    raw_pid = body.get("promise_id")
    try:
        promise_id = int(raw_pid) if raw_pid is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="promise_id must be an int")
    try:
        s = focus_session_service.start(
            db,
            title=body.get("title") or "",
            promise_id=promise_id,
            style=body.get("style") or "stopwatch",
            target_ms=body.get("target_ms"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(db, s)


@router.get("/focus/sessions/active")
def get_active_focus_session(db: Session = Depends(get_db)):
    """The live session, or `{"session": null}`.

    THE restore read: a refresh, a machine that slept, a second monitor and a
    cold app launch all recover the running session from here. It is also where
    a session that blew the 6h cap is retired — see
    `focus_session_service.active`.
    """
    s = focus_session_service.active(db)
    return {"session": _payload(db, s) if s is not None else None}


@router.get("/focus/sessions")
def list_focus_sessions(limit: int = 20, db: Session = Depends(get_db)):
    rows = focus_session_service.recent(db, limit=limit)
    return {"sessions": [focus_session_service.serialize(db, s) for s in rows]}


@router.get("/focus/sessions/{session_id}")
def get_focus_session(session_id: int, activity: bool = False, db: Session = Depends(get_db)):
    """One session. `?activity=1` folds in the sensor breakdown — the same
    payload `/focus/sessions/{id}/activity` serves, for callers that want both
    in one round trip."""
    return _payload(db, _require(db, session_id), with_activity=activity)


@router.get("/focus/sessions/{session_id}/activity")
def get_focus_session_activity(session_id: int, db: Session = Depends(get_db)):
    """What the sensors saw during this session, and the score built from it.

    Works while the session is still running — the open run is sealed at `now`
    through the lifecycle service's own closer, so the numbers are what the
    session would be scored on if it ended this instant.
    """
    return focus_session_service.activity(db, _require(db, session_id))


@router.patch("/focus/sessions/{session_id}")
def patch_focus_session(session_id: int, body: dict, db: Session = Depends(get_db)):
    """Style / target / kept. Deliberately NOT the lifecycle — a state change
    goes through its own verb so "pause" can never arrive as a field write that
    skips closing the open run."""
    s = _require(db, session_id)
    try:
        if "style" in body or "target_ms" in body:
            s = focus_session_service.set_style(
                db, s, style=body.get("style"), target_ms=body.get("target_ms")
            )
        if "kept" in body:
            s = focus_session_service.set_kept(db, s, bool(body.get("kept")))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(db, s)


@router.post("/focus/sessions/{session_id}/pause")
def pause_focus_session(session_id: int, db: Session = Depends(get_db)):
    return _payload(db, focus_session_service.pause(db, _require(db, session_id)))


@router.post("/focus/sessions/{session_id}/resume")
def resume_focus_session(session_id: int, db: Session = Depends(get_db)):
    return _payload(db, focus_session_service.resume(db, _require(db, session_id)))


@router.post("/focus/sessions/{session_id}/stop")
def stop_focus_session(session_id: int, db: Session = Depends(get_db)):
    """End the session and compute its final stats.

    The response carries the activity breakdown because the stop IS the moment
    the recap is built from — a client that had to make a second call could
    show a recap for a session whose entries had not landed yet.
    """
    s = focus_session_service.stop(db, _require(db, session_id))
    out = _payload(db, s, with_activity=True)
    # The "victory selfie" the write just attached to the last day's entry,
    # echoed here so the recap can render it without re-reading the entry it
    # came from. Null whenever the camera had nothing to show, which is the
    # ordinary case rather than a failure.
    out["completion_frame"] = focus_session_service.completion_frame(db)
    return out
