"""Screenpipe screen-evidence ingest for focus sessions — the desktop shell's
landing pad for what was on screen during a session.

Bearer-authed by the global middleware, same as the other sensor ingests
(/app/intervals, /browser/intervals, /focus/cam/*). The shell holds the token.

  POST /focus/sessions/{id}/screen-evidence        → batch of text frames (Phase 1)
  POST /focus/sessions/{id}/screen-evidence/summarize → run the ONE LLM summary
  POST /focus/sessions/{id}/screen-frame           → one frame's JPEG → R2 (Phase 2)
  GET  /focus/sessions/{id}/screen-evidence        → frames + summary (the recap read)

Session-scoped by construction: the shell only reads Screenpipe for the stopped
session's window, so nothing here is 24/7. Text is Phase 1; the image upload is
Phase 2 and is additive — a text frame with no image is a complete row.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import FocusSession
from ..services import screen_evidence_service

router = APIRouter()


@router.post("/focus/sessions/{session_id}/screen-evidence")
def ingest_screen_evidence(session_id: int, body: dict, db: Session = Depends(get_db)):
    """A batch of screen frames (text) for a session. Idempotent on client_id.

    Body: {"frames": [{client_id, ts, app?, window_name?, url?, title?, text?}],
           "final"?: bool}. `final: true` on the last batch triggers the summary
    in the same request, so the shell doesn't have to make a second call — but
    the summary route stays separate for a manual re-run.
    """
    result = screen_evidence_service.ingest_frames(db, session_id, body.get("frames"))
    if result.get("error") == "no such session":
        raise HTTPException(status_code=404, detail="session not found")
    if body.get("final"):
        result["summary"] = screen_evidence_service.summarize(db, session_id)
    return result


@router.post("/focus/sessions/{session_id}/screen-evidence/summarize")
def summarize_screen_evidence(session_id: int, db: Session = Depends(get_db)):
    """Run (or re-run) the LLM summary over whatever evidence has landed."""
    session = db.get(FocusSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return screen_evidence_service.summarize(db, session_id)


@router.post("/focus/sessions/{session_id}/screen-frame")
async def upload_screen_frame(
    session_id: int,
    client_id: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Phase 2: one frame's JPEG → R2, its key attached to the matching text row.

    Keyed by `client_id` (the same id the text batch carried), so image and text
    land on one row regardless of order. A frame whose text row hasn't arrived
    (or was rejected) returns matched=false rather than erroring — the image is
    additive, and losing it must never fail the session.
    """
    from ..services import image_storage

    session = db.get(FocusSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        up = image_storage.upload_file(
            data, file.content_type or "image/jpeg", file.filename, prefix="screen-frames"
        )
    except Exception as e:
        # R2 not configured, or a transient upload failure. The text row stands;
        # the frame simply stays image-less. 503 so the shell can retry.
        raise HTTPException(status_code=503, detail=f"upload failed: {e}")

    matched = screen_evidence_service.set_frame_image(db, client_id, up["key"])
    return {"matched": matched, "url": up["url"], "key": up["key"]}


@router.get("/focus/sessions/{session_id}/screen-evidence")
def get_screen_evidence(session_id: int, db: Session = Depends(get_db)):
    """The recap read: every frame (time-ordered, with image URLs where present)
    plus the session's stored summary."""
    session = db.get(FocusSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    frames = screen_evidence_service.frames_for_session(db, session_id)
    return {
        "session_id": session_id,
        "summary": session.screen_summary,
        "on_task_pct": session.on_task_pct,
        "summary_at": session.summary_at.isoformat() + "+00:00" if session.summary_at else None,
        "frames": [screen_evidence_service.serialize_frame(f) for f in frames],
    }
