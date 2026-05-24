
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    List as ListModel,
    ListItem,
)

from ..serializers import (
    _serialize_list, _serialize_list_item
)


router = APIRouter()


@router.get("/lists")
def get_lists(db: Session = Depends(get_db)):
    from ..services.list_service import list_service
    return [_serialize_list(lst) for lst in list_service.get_all_lists(db)]


@router.get("/lists/{list_id}")
def get_list(list_id: int, db: Session = Depends(get_db)):
    from ..services.list_service import list_service
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    items = list_service.get_items(list_id, db)
    return {
        **_serialize_list(lst),
        "items": [_serialize_list_item(it) for it in items],
    }


@router.post("/lists")
def create_list(body: dict, db: Session = Depends(get_db)):
    from ..services.list_service import list_service
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    type_ = body.get("type") or "generic"
    if type_ not in ("todo", "backlog", "generic"):
        raise HTTPException(status_code=400, detail="type must be todo|backlog|generic")
    emoji = body.get("emoji")
    lst = list_service.get_or_create_list(name, type_, emoji, db)
    return _serialize_list(lst)


@router.patch("/lists/{list_id}")
def update_list(list_id: int, body: dict, db: Session = Depends(get_db)):
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        lst.name = name
    if "emoji" in body:
        emoji = body.get("emoji")
        lst.emoji = emoji if emoji else None
    if "kind" in body:
        kind = body.get("kind")
        if kind not in ("tasks", "ideas"):
            raise HTTPException(status_code=400, detail="kind must be tasks|ideas")
        lst.kind = kind
    db.commit()
    db.refresh(lst)
    return _serialize_list(lst)


@router.delete("/lists/{list_id}")
def delete_list(list_id: int, db: Session = Depends(get_db)):
    """Cascade delete the list and all of its items."""
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    # Refuse to delete the canonical singletons — they're recreated on next
    # boot and break tools/orchestrator that look them up by type.
    if lst.type in ("todo", "backlog", "focus"):
        raise HTTPException(
            status_code=400,
            detail=f"cannot delete canonical {lst.type} list",
        )
    db.query(ListItem).filter(ListItem.list_id == list_id).delete(
        synchronize_session=False
    )
    db.delete(lst)
    db.commit()
    return {"ok": True}


@router.post("/lists/{list_id}/items")
def add_list_item(list_id: int, body: dict, db: Session = Depends(get_db)):
    """Insert a list item.

    Conflict detection: by default we cosine-search existing items in the same
    list and return any near-duplicates as `conflicts: [{id, text, similarity,
    severity}]`. Caller decides how to surface them. Pass `skip_conflict_check`
    in the body to bypass the embed call (used by bulk imports / migrations).
    """
    from ..services.list_service import (
        list_service,
        CONFLICT_HIGH,
    )
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    actionable = body.get("actionable")
    skip_check = bool(body.get("skip_conflict_check"))
    if skip_check:
        item = list_service.add_item(
            list_id, text, db,
            subtitle=(body.get("subtitle") or None),
            source_note_id=body.get("source_note_id"),
            actionable=(True if actionable is None else bool(actionable)),
        )
        return _serialize_list_item(item)
    item, conflicts = list_service.add_item_with_conflict_check(
        list_id, text, db,
        subtitle=(body.get("subtitle") or None),
        source_note_id=body.get("source_note_id"),
        actionable=(True if actionable is None else bool(actionable)),
    )
    return {
        **_serialize_list_item(item),
        "conflicts": [
            {
                "id": c.id,
                "text": c.text,
                "subtitle": c.subtitle,
                "similarity": round(sim, 3),
                "severity": "high" if sim >= CONFLICT_HIGH else "medium",
            }
            for c, sim in conflicts
        ],
    }


@router.post("/lists/{list_id}/similar")
def find_similar_list_items(list_id: int, body: dict, db: Session = Depends(get_db)):
    """Cosine-search items in a list against a query text. Read-only — does
    not mutate. Powers the MCP `find_similar_items` tool + future UI
    duplicate-warning surfaces."""
    from ..services.list_service import list_service, CONFLICT_MEDIUM

    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    try:
        threshold = float(body.get("threshold", CONFLICT_MEDIUM))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="threshold must be a number")
    try:
        limit = int(body.get("limit", 5))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="limit must be an int")
    matches = list_service.find_similar_in_list(
        list_id,
        text,
        db,
        subtitle=(body.get("subtitle") or None),
        threshold=threshold,
        limit=limit,
        include_done=bool(body.get("include_done")),
        exclude_item_id=body.get("exclude_item_id"),
    )
    return {
        "matches": [
            {
                "id": it.id,
                "text": it.text,
                "subtitle": it.subtitle,
                "done": bool(it.done),
                "similarity": round(sim, 3),
            }
            for it, sim in matches
        ],
    }
