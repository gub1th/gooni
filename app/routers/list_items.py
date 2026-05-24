
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..serializers import (
    _serialize_list_item
)


router = APIRouter()


@router.patch("/list-items/{item_id}")
def update_list_item(item_id: int, body: dict, db: Session = Depends(get_db)):
    """Update a generic list_items row. After the focus/todo/backlog
    extraction, fields like is_primary / board_status / pr_url / due_date
    no longer live here — patch them via /focuses/{id}, /todos/{id}, or
    /backlog/tickets/{id} instead.
    """
    from ..services.list_service import list_service

    item = list_service.update_item(
        item_id, db,
        text=body.get("text"),
        subtitle=body.get("subtitle"),
        done=body.get("done"),
        actionable=body.get("actionable"),
        sort_order=body.get("sort_order"),
    )
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return _serialize_list_item(item)


@router.delete("/list-items/{item_id}")
def delete_list_item(item_id: int, db: Session = Depends(get_db)):
    from ..services.list_service import list_service
    if not list_service.delete_item(item_id, db):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@router.post("/list-items/reorder")
def reorder_list_items(body: dict, db: Session = Depends(get_db)):
    """Batch sort_order update. Body: {ids: [item_id, item_id, ...]} in target order."""
    from ..services.list_service import list_service
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list")
    list_service.reorder_items([int(i) for i in ids], db)
    return {"ok": True}
