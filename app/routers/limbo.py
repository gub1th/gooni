from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db


router = APIRouter()


@router.get("/limbo")
def limbo_list(limit: int = 100, db: Session = Depends(get_db)):
    """Open limbo items, most-mentioned first. Drives the desktop review
    queue (PR-5)."""
    from ..services import limbo_service
    rows = limbo_service.list_open(db, limit=limit)
    return [limbo_service.serialize(r) for r in rows]


@router.post("/limbo/{item_id}/promote")
def limbo_promote(item_id: int, body: dict, db: Session = Depends(get_db)):
    """Promote a limbo item into a typed primitive. Body: {target_type:
    focus|todo|promise|memory}. Creates the row, wires a derives_from edge,
    flips status."""
    from ..services import limbo_service
    target = (body or {}).get("target_type")
    result = limbo_service.promote(db, item_id, target)
    if result is None:
        raise HTTPException(400, "promote failed — bad target_type or item not found")
    return {
        "item": limbo_service.serialize(result["item"]),
        "target_type": result["target_type"],
        "target_id": result["target_id"],
        "already": result.get("already", False),
    }


@router.post("/limbo/{item_id}/dismiss")
def limbo_dismiss(item_id: int, db: Session = Depends(get_db)):
    """Tombstone a limbo item — won't resurface or re-bump."""
    from ..services import limbo_service
    item = limbo_service.dismiss(db, item_id)
    if item is None:
        raise HTTPException(404, "limbo item not found")
    return limbo_service.serialize(item)


@router.post("/batch/run")
def batch_run(body: dict | None = None, db: Session = Depends(get_db)):
    """Manually fire the 5am batch processor now (testing / on-demand).
    Body: {window_hours?: int} (default 24). Bypasses the day-stamp."""
    from ..services import batch_service
    window = int((body or {}).get("window_hours") or 24)
    return batch_service.run(db, window_hours=window)
