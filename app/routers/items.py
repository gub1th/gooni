
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services.item_service import item_service

from ..serializers import (
    _serialize_item
)
from ..common import (
    _parse_optional_due, _parse_optional_dt, _validate_health, _validate_status, _validate_scale
)


router = APIRouter()


@router.get("/items")
def items_tree(
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Tree: focuses (top-level w/ endgoal) + inbox (top-level todos), each
    with nested children + per-node progress + stale flag.

    Pagination is at the *root* level. `limit` (clamped to [1, 200], default
    50) caps how many top-level focuses + how many top-level todos are
    returned. Each surviving root keeps its full subtree intact, so
    rendering progress + stale flags stays accurate.

    Response carries `total_focuses` / `total_inbox` so the frontend can
    decide whether to show a "Load more" affordance. Default limit (50)
    is well above the typical user's count today; this is mostly a guard
    against the response payload growing without bound as the data scales.
    """
    return item_service.list_tree(db, limit=limit, offset=offset)


@router.get("/items/today")
def items_today(db: Session = Depends(get_db)):
    """Open leaves due today, plus undated leaves under committed focuses,
    plus inbox todos. Each item carries its parent_chain for context.
    """
    return item_service.today(db)


@router.post("/items")
def items_create(body: dict, db: Session = Depends(get_db)):
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    parent_id = body.get("parent_id")
    endgoal = (body.get("endgoal") or "").strip() or None
    committed = bool(body.get("committed", False))
    due_date = _parse_optional_due(body.get("due_date"))
    status = _validate_status(body.get("status"))
    scale = _validate_scale(body.get("scale"))
    is_primary = bool(body.get("is_primary", False))
    health = _validate_health(body.get("health"))
    confidence = _validate_health(body.get("confidence"))  # same 0..100 shape
    start_at = _parse_optional_dt(body.get("start_at"))
    end_at = _parse_optional_dt(body.get("end_at"))
    try:
        item = item_service.create(
            db,
            text=text_val,
            parent_id=int(parent_id) if parent_id is not None else None,
            endgoal=endgoal,
            committed=committed,
            due_date=due_date,
            source_note_id=body.get("source_note_id"),
            status=status,
            scale=scale,
            health=health,
            confidence=confidence,
            start_at=start_at,
            end_at=end_at,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # is_primary is a singleton-toggle, handled in update() (which clears
    # any other primary). Apply post-create when requested.
    if is_primary:
        item = item_service.update(db, item.id, is_primary=True) or item
    return _serialize_item(item)


@router.patch("/items/{item_id}")
def items_update(item_id: int, body: dict, db: Session = Depends(get_db)):
    patch: dict = {}
    if "text" in body:
        new_text = (body["text"] or "").strip()
        if new_text:
            patch["text"] = new_text
    if "endgoal" in body:
        eg = body["endgoal"]
        patch["endgoal"] = (eg or "").strip() or None if isinstance(eg, str) else None
    if "committed" in body:
        patch["committed"] = bool(body["committed"])
    if "done" in body:
        patch["done"] = bool(body["done"])
    if "due_date" in body:
        patch["due_date"] = _parse_optional_due(body["due_date"])
    if "subtitle" in body:
        patch["subtitle"] = body["subtitle"] or None
    if "sort_order" in body:
        patch["sort_order"] = int(body["sort_order"])
    if "parent_id" in body:
        patch["parent_id"] = (
            int(body["parent_id"]) if body["parent_id"] is not None else None
        )
    if "actionable" in body:
        patch["actionable"] = bool(body["actionable"])
    if "is_primary" in body:
        patch["is_primary"] = bool(body["is_primary"])
    if "state" in body:
        # Todo state enum (not_yet | doing | done). Reaches Todo via the
        # item_service facade → todo_service.update which keeps `done`
        # in sync + auto-clears is_primary on completion.
        patch["state"] = body["state"]
    if "focus_id" in body:
        patch["focus_id"] = (
            int(body["focus_id"]) if body["focus_id"] is not None else None
        )
    if "color" in body:
        patch["color"] = body["color"] or None
    if "status" in body:
        patch["status"] = _validate_status(body["status"])
    if "scale" in body:
        patch["scale"] = _validate_scale(body["scale"])
    if "health" in body:
        patch["health"] = _validate_health(body["health"])
    if "confidence" in body:
        patch["confidence"] = _validate_health(body["confidence"])
    if "start_at" in body:
        patch["start_at"] = _parse_optional_dt(body["start_at"])
    if "end_at" in body:
        patch["end_at"] = _parse_optional_dt(body["end_at"])
    item = item_service.update(db, item_id, **patch)
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return _serialize_item(item)


@router.delete("/items/{item_id}")
def items_delete(item_id: int, db: Session = Depends(get_db)):
    if not item_service.delete(db, item_id):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@router.post("/items/reorder")
def items_reorder(body: dict, db: Session = Depends(get_db)):
    ids = body.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list")
    item_service.reorder(db, [int(i) for i in ids])
    return {"ok": True}


@router.get("/items/{todo_id}/focuses")
def items_get_focuses_for_todo(todo_id: int, db: Session = Depends(get_db)):
    """Return the focus linked to this todo (0 or 1 element). Kept as a
    list shape for back-compat with callers that expect the old M2M
    response."""
    from ..services.todo_service import todo_service
    from ..services.focus_service import focus_service
    todo = todo_service.get(db, todo_id)
    if not todo or not todo.focus_id:
        return []
    f = focus_service.get(db, todo.focus_id)
    if not f:
        return []
    return [{"id": f.id, "text": f.text, "color": f.color}]


@router.get("/items/{focus_id}/todos")
def items_get_todos_for_focus(focus_id: int, db: Session = Depends(get_db)):
    """Return the todos linked to a given focus."""
    from ..services.focus_service import focus_service
    from ..services.todo_service import serialize_todo
    todos = focus_service.linked_todos(db, focus_id)
    return [serialize_todo(t) for t in todos]


@router.post("/items/{focus_id}/derive-todo")
def items_derive_todo(focus_id: int, body: dict, db: Session = Depends(get_db)):
    """Create a leaf todo with focus_id set to this focus.

    Body: {"text": str, "due_date"?: iso8601 | "today" | "tomorrow"}.
    Returns {"todo": serialized_todo}.
    """
    from ..services.focus_service import focus_service
    from ..services.todo_service import todo_service, serialize_todo

    focus = focus_service.get(db, focus_id)
    if not focus:
        raise HTTPException(status_code=404, detail="focus not found")

    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    due_date = _parse_optional_due(body.get("due_date"))

    todo = todo_service.create(db, text=text_val, due_date=due_date, focus_id=focus.id)
    return {"todo": serialize_todo(todo)}


@router.post("/items/{focus_id}/link-todo/{todo_id}")
def items_link_existing_todo(focus_id: int, todo_id: int, db: Session = Depends(get_db)):
    """Set the todo's focus_id to this focus. Idempotent — re-linking
    the same pair is a no-op."""
    from ..services.focus_service import focus_service
    from ..services.todo_service import todo_service

    focus = focus_service.get(db, focus_id)
    todo = todo_service.get(db, todo_id)
    if not focus or not todo:
        raise HTTPException(status_code=404, detail="focus or todo not found")
    if todo.focus_id == focus_id:
        return {"linked": True, "created": False}
    todo_service.update(db, todo_id, focus_id=focus_id)
    return {"linked": True, "created": True}


@router.get("/items/today-todos")
def items_today_todos(db: Session = Depends(get_db)):
    """Open todos due today + their linked-focus chips. Powers the
    dashboard's Today's todos section."""
    from ..services.todo_service import todo_service
    return todo_service.today(db)
