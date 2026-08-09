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
  PATCH  /focus/reminders/{id}    edit fields OR toggle state/done
  DELETE /focus/reminders/{id}    hard-delete
  GET    /focus/dashboard         assembled glanceable payload
"""

import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..common import _parse_iso_date, local_today, parse_due_hint
from ..db.database import get_db
from ..services import focus_service

router = APIRouter()

# Phone photos are large; the code sandbox can downscale before POST, so this
# is a backstop, not the expected size. Matches /uploads/image's cap.
_MAX_IMAGE_BYTES = 10 * 1024 * 1024


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
    # `at` backdates the thought. The timestamp used to be stamped at call time
    # with no override, so a session logged late showed late — and the connector
    # instructions had to work around the gap instead of the tool closing it.
    at = None
    raw_at = body.get("at")
    if raw_at:
        try:
            at = datetime.fromisoformat(str(raw_at).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail=f"bad at: {raw_at!r}")
        # Same offset-aware → naive-UTC normalization `_parse_due` does; a naive
        # input is assumed already-UTC (the storage convention).
        if at.tzinfo is not None:
            at = at.astimezone(timezone.utc)
        at = at.replace(tzinfo=None)
    result = focus_service.log_thought(
        db,
        content=content,
        topic_name=topic,
        new_batch=bool(body.get("new_batch")),
        label=(body.get("label") or None),
        at=at,
    )
    db.commit()
    return result


@router.post("/focus/cards/image")
async def post_image_card(
    file: UploadFile = File(...),
    caption: str = Form(""),
    topic: str = Form("captures"),
    authorization: str = Header(""),
    db: Session = Depends(get_db),
):
    """Ingest a photo into the arcs canvas as an image card.

    Scoped-key authed (FOCUS_UPLOAD_KEY) — NOT the master Bearer — because the
    caller is a Claude code-execution sandbox. A photo uploaded in a Claude
    conversation can't reach Gooni through the model (tool-call args are text,
    and the model has no handle to the upload's bytes), but the sandbox reads
    the bytes AND has network egress, so it POSTs them here. This route is
    exempt from the global Bearer middleware (main.py) and guards itself with a
    revocable, upload-only key so the master token never has to sit in a chat.

    Bytes → R2 → a new batch card carrying the public url + caption. One card
    per post (new_batch=True), threaded to `topic` like every other card.
    """
    expected = (os.getenv("FOCUS_UPLOAD_KEY") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="FOCUS_UPLOAD_KEY not configured")
    # Constant-time compare — the key is a shared secret; don't leak length via
    # early-exit timing.
    if not secrets.compare_digest(authorization.strip(), f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="bad upload key")

    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail=f"unsupported content-type: {content_type}")
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image too large: {len(data)} bytes (max {_MAX_IMAGE_BYTES})",
        )

    from ..services import image_storage

    if not image_storage.is_configured():
        raise HTTPException(status_code=503, detail="R2 image storage not configured")
    try:
        result = image_storage.upload_image(data, content_type, file.filename)
    except image_storage.R2NotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:  # noqa: BLE001 — generic 502, don't leak bucket internals
        print(f"R2 upload failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="upload failed")

    caption = (caption or "").strip()
    topic = (topic or "").strip() or "captures"
    card = focus_service.log_thought(
        db,
        content=(caption or "[image]"),
        topic_name=topic,
        new_batch=True,  # each photo is its own card
        label=(caption or "Gooni pinned a photo"),
        image_url=result["url"],
    )
    db.commit()
    return card


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


# Body keys that mean "edit these fields" (vs the state/done lifecycle branch).
_EDIT_KEYS = {"content", "due_at", "due_hint", "owed_to", "clear_due", "clear_owed"}


@router.patch("/focus/reminders/{reminder_id}")
def toggle_reminder(reminder_id: int, body: dict, db: Session = Depends(get_db)):
    """Two jobs on one verb, dispatched by body shape:

    - EDIT: any of content / due_at / due_hint / owed_to / clear_due / clear_owed
      present → update the row's fields. `clear_due`/`clear_owed` NULL a field;
      a due_hint ("friday") delegates to THE one deadline parser.
    - LIFECYCLE: `state` (active|kept|broken) drives the said-vs-done spine, or
      `done` for the legacy boolean check-off (done → kept).
    """
    if _EDIT_KEYS & body.keys():
        clear_due = bool(body.get("clear_due"))
        # Only resolve a new due when NOT clearing and a due key was actually
        # sent — otherwise leave due_at untouched (None = "no change" here).
        due_at = None
        if not clear_due and ("due_at" in body or "due_hint" in body):
            due_at = _parse_due(body, db)
        try:
            result = focus_service.update_reminder(
                db,
                reminder_id,
                content=body.get("content"),
                due_at=due_at,
                clear_due=clear_due,
                owed_to=body.get("owed_to"),
                clear_owed=bool(body.get("clear_owed")),
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
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


@router.delete("/focus/reminders/{reminder_id}")
def remove_reminder(reminder_id: int, db: Session = Depends(get_db)):
    """Hard-delete a reminder/promise (rail X → confirm). Idempotent 404 if gone."""
    if not focus_service.delete_reminder(db, reminder_id):
        raise HTTPException(status_code=404, detail="reminder not found")
    db.commit()
    return {"deleted": reminder_id}


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
