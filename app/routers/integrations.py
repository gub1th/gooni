
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..services import github as gh
from ..services import google_calendar as gcal


router = APIRouter()


@router.post("/calendar/events")
def calendar_create_event(body: dict, db: Session = Depends(get_db)):
    """Create a Google Calendar event on the user's primary calendar.
    Body: { summary, start_iso, end_iso, description?, time_zone? }
    """
    summary = (body.get("summary") or "").strip()
    start_iso = body.get("start_iso")
    end_iso = body.get("end_iso")
    if not summary or not start_iso or not end_iso:
        raise HTTPException(status_code=400, detail="summary, start_iso, end_iso are required")
    try:
        event = gcal.create_event(
            db,
            summary=summary,
            start_iso=start_iso,
            end_iso=end_iso,
            description=body.get("description"),
            time_zone=body.get("time_zone"),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Calendar API error: {e}")
    return {
        "id": event.get("id"),
        "html_link": event.get("htmlLink"),
        "summary": event.get("summary"),
        "start": event.get("start"),
        "end": event.get("end"),
    }





