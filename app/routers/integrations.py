
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..services import github as gh
from ..services import google_calendar as gcal
from ..services import event_service


router = APIRouter()


@router.post("/events")
def event_ingest(body: dict, db: Session = Depends(get_db)):
    """Generic iOS Shortcuts event ingest (behind the standard Bearer auth the
    Shortcut attaches). Body: { subject, event, at? } — e.g.
    {"subject":"gym","event":"arrive"} or
    {"subject":"instagram","event":"open","at":"2026-07-16T21:04:00-07:00"}.
    Logs +1 on the "{subject} {event}" sum-agg Trackable for the event's local
    day; the clock time is stored in value_json.at. `at` accepts ISO-8601 or
    epoch seconds and defaults to now.
    """
    try:
        return event_service.log_event(
            db,
            subject=body.get("subject", ""),
            event=body.get("event", ""),
            at=body.get("at"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _serialize_event(ev: dict) -> dict:
    """Flatten a raw Google event into the shape the calendar widget wants:
    start/end as single ISO strings (dateTime for timed events, the bare
    YYYY-MM-DD `date` for all-day), plus an `all_day` flag so the frontend
    doesn't have to sniff Google's start.dateTime-vs-start.date union.
    """
    start = ev.get("start") or {}
    end = ev.get("end") or {}
    all_day = "date" in start and "dateTime" not in start
    return {
        "id": ev.get("id"),
        "summary": ev.get("summary") or "(untitled)",
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "all_day": all_day,
        "html_link": ev.get("htmlLink"),
        "description": ev.get("description"),
        "location": ev.get("location"),
    }


@router.get("/calendar/events")
def calendar_list_events(start: str, end: str, db: Session = Depends(get_db)):
    """List primary-calendar events in the [start, end) window. `start`/`end`
    are RFC3339 (with offset or trailing Z). Returns the flattened widget shape.
    """
    try:
        items = gcal.list_events(db, time_min_iso=start, time_max_iso=end, max_results=100)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Calendar API error: {e}")
    return [_serialize_event(ev) for ev in items]


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
    return _serialize_event(event)


@router.patch("/calendar/events/{event_id}")
def calendar_update_event(event_id: str, body: dict, db: Session = Depends(get_db)):
    """Patch an existing event. Body: any of { summary, start_iso, end_iso,
    description, time_zone } — only the passed fields change (Google merges).
    """
    if not any(k in body for k in ("summary", "start_iso", "end_iso", "description")):
        raise HTTPException(status_code=400, detail="nothing to update")
    try:
        event = gcal.update_event(
            db,
            event_id,
            summary=body.get("summary"),
            start_iso=body.get("start_iso"),
            end_iso=body.get("end_iso"),
            description=body.get("description"),
            time_zone=body.get("time_zone"),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Calendar API error: {e}")
    return _serialize_event(event)


@router.delete("/calendar/events/{event_id}")
def calendar_delete_event(event_id: str, db: Session = Depends(get_db)):
    """Delete an event from the primary calendar. Idempotent (Google's 410
    Gone is treated as success upstream)."""
    try:
        gcal.delete_event(db, event_id)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Calendar API error: {e}")
    return {"deleted": True}





