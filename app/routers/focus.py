"""Focus-system routes (PRD `gooni-focus-system-plan.md`). The HTTP contract
the six MCP tools and the glanceable dashboard both hang off. Auth is the
global Bearer middleware — no per-route guard here.

Endpoints:
  POST   /focus/thoughts          log_thought  (resolve topic, batch rule, bump)
  GET    /focus/topics            list_topics  (decayed salience + growth)
  POST   /focus/topics            create_topic
  GET    /focus/thoughts          query_thoughts
  POST   /focus/reminders         set_reminder
  GET    /focus/reminders         list_reminders
  PATCH  /focus/reminders/{id}    toggle done (dashboard check-off)
  GET    /focus/dashboard         assembled glanceable payload
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..common import _parse_iso_date, local_today, parse_due_hint
from ..db.database import get_db
from ..services import focus_service

router = APIRouter()


def _parse_due(body: dict, db: Session) -> datetime | None:
    """Accept either an explicit ISO `due_at` or a natural-language `due_hint`
    ("tonight", "friday"). Hint delegates to THE one deadline parser."""
    raw = body.get("due_at")
    if raw:
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail=f"bad due_at: {raw!r}")
        # Offset-aware input (…+00:00 / -07:00 / Z) → convert to UTC BEFORE
        # dropping tzinfo, so the naive-UTC column stores the right instant. A
        # naive input is assumed already-UTC (the storage convention). Without
        # the astimezone a local-offset time kept its wall-clock digits and
        # landed hours off.
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc)
        return dt.replace(tzinfo=None)
    hint = body.get("due_hint")
    if hint and str(hint).strip():
        return parse_due_hint(str(hint), db)
    return None


# ── Thoughts ─────────────────────────────────────────────────────────────────


@router.post("/focus/thoughts")
def log_thought(body: dict, db: Session = Depends(get_db)):
    content = (body.get("content") or "").strip()
    topic = (body.get("topic") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    if not topic:
        raise HTTPException(status_code=400, detail="topic required")
    result = focus_service.log_thought(
        db,
        content=content,
        topic_name=topic,
        new_batch=bool(body.get("new_batch")),
        label=(body.get("label") or None),
    )
    db.commit()
    return result


@router.get("/focus/thoughts")
def query_thoughts(
    topic: str | None = None,
    since: str | None = None,
    text: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    since_dt = None
    if since:
        d = _parse_iso_date(since)
        if d is None:
            raise HTTPException(status_code=400, detail=f"bad since date: {since!r}")
        since_dt = datetime(d.year, d.month, d.day)
    return focus_service.query_thoughts(db, topic=topic, since=since_dt, text=text, limit=limit)


# ── Topics ───────────────────────────────────────────────────────────────────


@router.get("/focus/topics")
def list_topics(db: Session = Depends(get_db)):
    return focus_service.list_topics(db)


@router.post("/focus/topics")
def create_topic(body: dict, db: Session = Depends(get_db)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    topic = focus_service.create_topic(db, name=name, parent=body.get("parent"))
    db.commit()
    return {
        "id": topic.id,
        "name": topic.name,
        "parent_id": topic.parent_id,
        "color": topic.color,
        "salience": topic.salience,
    }


# ── Reminders ────────────────────────────────────────────────────────────────


@router.post("/focus/reminders")
def set_reminder(body: dict, db: Session = Depends(get_db)):
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    due_at = _parse_due(body, db)
    from_thought = body.get("from_thought")
    result = focus_service.set_reminder(
        db,
        content=content,
        due_at=due_at,
        owed_to=(body.get("owed_to") or None),
        from_thought=int(from_thought) if from_thought else None,
        is_promise=bool(body.get("is_promise")),
    )
    db.commit()
    return result


@router.get("/focus/reminders")
def list_reminders(day: str | None = None, include_done: bool = False, db: Session = Depends(get_db)):
    day_dt = None
    if day == "today":
        day_dt = datetime.combine(local_today(db), datetime.min.time())
    elif day:
        d = _parse_iso_date(day)
        if d is None:
            raise HTTPException(status_code=400, detail=f"bad day: {day!r}")
        day_dt = datetime(d.year, d.month, d.day)
    return focus_service.list_reminders(db, day=day_dt, include_done=include_done)


@router.patch("/focus/reminders/{reminder_id}")
def toggle_reminder(reminder_id: int, body: dict, db: Session = Depends(get_db)):
    """Dashboard check-off / promise lifecycle. Pass `state` (active|kept|broken)
    to drive the said-vs-done spine directly, or `done` for the legacy boolean
    check-off (done → kept)."""
    state = body.get("state")
    if state is not None:
        try:
            result = focus_service.set_reminder_state(db, reminder_id, str(state))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        result = focus_service.set_reminder_done(db, reminder_id, done=bool(body.get("done", True)))
    if result is None:
        raise HTTPException(status_code=404, detail="reminder not found")
    db.commit()
    return result


# ── Stream (arcs canvas) ─────────────────────────────────────────────────────


@router.get("/focus/stream")
def stream(days: int = 7, end: str | None = None, db: Session = Depends(get_db)):
    """The arcs-canvas chronological stream: thought batch-cards + Shortcuts
    device events merged newest-first over a LOCAL-day window. `end` (ISO date)
    + `days` page back in time for infinite scroll; default = last 7 days."""
    end_date = None
    if end:
        d = _parse_iso_date(end)
        if d is None:
            raise HTTPException(status_code=400, detail=f"bad end date: {end!r}")
        end_date = d
    return focus_service.stream(db, days=days, end=end_date)


# ── Dashboard ────────────────────────────────────────────────────────────────


@router.get("/focus/dashboard")
def dashboard(db: Session = Depends(get_db)):
    """Assembled glanceable payload. Google Calendar events + trackable
    activity are merged CLIENT-SIDE from their existing endpoints — this
    returns only Gooni-owned focus data."""
    payload = focus_service.dashboard(db)
    # dashboard() runs auto_break_overdue (flushed, not committed) — persist the
    # self-heal so a blown deadline stays broken across requests.
    db.commit()
    return payload
