"""Focus-cam ingest + serve routes (brain side of the local webcam focus
sidecar). Bearer-authed by the global middleware — no per-route guard.

Deliberately NAMESPACED under /focus/cam/* to stay clear of the Focus SYSTEM
(topics/thoughts/reminders on /focus/*) — same word, unrelated surface.

  GET   /focus/cam            → the control+state blob (sidecar reads control;
                               frontend reads state/score/app + live preview frame)
  POST  /focus/cam/state      → sidecar reports live state (on change + ~30s keepalive)
  POST  /focus/cam/control    → UI Start/Stop sets desired control (running|idle)
  POST  /focus/cam/frame      → sidecar ships the latest preview thumbnail (~10s)
  POST  /focus/cam/events     → sidecar reports one discrete event (+1 counter)
  POST  /focus/cam/sessions   → sidecar reports a finished session (on stop)
  GET   /focus/cam/today      → the widget read: today's sessions + event counts

All focus data stores as source="focus_cam" Trackables, walled off from every
existing trackable surface (see focus_cam_service / trackable_service.HIDDEN_SOURCES).
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import focus_cam_service

router = APIRouter()

# Preview frame is ~10-20KB base64 (320px, JPEG q60). Cap well above that so a
# malformed/oversized payload can't bloat the single Settings row; the sidecar
# never sends anything near this.
_MAX_FRAME_B64_CHARS = 200_000


@router.get("/focus/cam")
def get_focus_cam(db: Session = Depends(get_db)):
    """The current control+state blob. Both the sidecar and the frontend read
    this (sidecar → control; frontend → state/score/app + the live preview
    frame). `frame` is a ready-to-render data: URL; `frame_at` its timestamp."""
    return focus_cam_service.get_public_blob(db)


@router.post("/focus/cam/state")
def post_focus_cam_state(body: dict, db: Session = Depends(get_db)):
    """Sidecar reports live state. Merges state/score/app/session_id/at into the
    blob (control untouched). Barely churns Settings — sent on state-change + a
    ~30s keepalive."""
    blob = focus_cam_service.merge_state(
        db,
        session_id=body.get("session_id"),
        at=body.get("at"),
        state=body.get("state"),
        score=body.get("score"),
        app=body.get("app"),
    )
    return {"ok": True, "state": blob.get("state"), "control": blob.get("control")}


@router.post("/focus/cam/control")
def post_focus_cam_control(body: dict, db: Session = Depends(get_db)):
    """The UI Start/Stop button. Sets desired control; the sidecar polls GET
    /focus/cam and reconciles. (The sidecar owns session_id — not generated here.)

    Optional `target_reminder_id` binds the run to one short-term promise, so the
    post-session report can name it and offer to mark it kept."""
    control = (body.get("control") or "").strip()
    raw_target = body.get("target_reminder_id")
    try:
        target = int(raw_target) if raw_target is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="target_reminder_id must be an int")
    try:
        blob = focus_cam_service.set_control(db, control, target_reminder_id=target)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"control": blob["control"], "target_reminder_id": blob.get("target_reminder_id")}


@router.post("/focus/cam/frame")
def post_focus_cam_frame(body: dict, db: Session = Depends(get_db)):
    """Sidecar ships the latest preview thumbnail (~10s cadence + on state flip).
    Store LATEST ONLY — overwrite, no history (a stale thumbnail is worthless).
    A live frame is the widget's liveness proof; freshness of `frame_at` is what
    tells a really-running sidecar from a dead one that still reads control=running."""
    jpeg_b64 = body.get("jpeg_b64")
    if not jpeg_b64 or not isinstance(jpeg_b64, str):
        raise HTTPException(status_code=400, detail="jpeg_b64 required")
    if len(jpeg_b64) > _MAX_FRAME_B64_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"frame too large: {len(jpeg_b64)} chars (max {_MAX_FRAME_B64_CHARS})",
        )
    focus_cam_service.set_frame(
        db,
        session_id=body.get("session_id"),
        at=body.get("at"),
        state=body.get("state"),
        jpeg_b64=jpeg_b64,
    )
    return {"ok": True}


@router.post("/focus/cam/events")
def post_focus_cam_event(body: dict, db: Session = Depends(get_db)):
    """Sidecar reports one discrete event (distracted/phone/vape/stand/left_desk)
    → +1 on the per-kind counter for the event's local day."""
    kind = (body.get("kind") or "").strip()
    started_at = body.get("started_at")
    if not started_at:
        raise HTTPException(status_code=400, detail="started_at required")
    try:
        return focus_cam_service.log_event(
            db,
            session_id=body.get("session_id"),
            kind=kind,
            started_at=started_at,
            ended_at=body.get("ended_at"),
            duration_sec=body.get("duration_sec"),
            activity=body.get("activity"),
            evidence_id=body.get("evidence_id"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/focus/cam/sessions")
def post_focus_cam_session(body: dict, db: Session = Depends(get_db)):
    """Sidecar reports a finished session (on stop) → one json Trackable entry
    holding the full report, on the session's local end-day."""
    if not body.get("ended_at"):
        raise HTTPException(status_code=400, detail="ended_at required")
    if not body.get("session_id"):
        raise HTTPException(status_code=400, detail="session_id required")
    return focus_cam_service.log_session(db, body)


@router.get("/focus/cam/today")
def get_focus_cam_today(db: Session = Depends(get_db)):
    """The widget read: today's sessions + per-kind event counts. Reads focus
    data by name/source directly (it's invisible to the generic trackable list)."""
    return focus_cam_service.today_summary(db)
