
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..common import (
    _parse_iso_date
)


router = APIRouter()


@router.get("/habits")
def habits_list(db: Session = Depends(get_db)):
    """Active habits w/ each habit's 7-day strip + current streak. Drives
    the dashboard widget. Sorted by sort_order, id."""
    from ..services import habit_service
    rows = habit_service.list_active(db)
    return [
        habit_service.serialize_habit(h, include_derived=True, db=db)
        for h in rows
    ]


@router.post("/habits")
def habits_create(body: dict, db: Session = Depends(get_db)):
    """Create a habit. Body: {name, polarity?, color?}. Polarity
    defaults to 'positive'."""
    from ..services import habit_service
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    polarity = body.get("polarity") or "positive"
    if polarity not in ("positive", "negative"):
        raise HTTPException(400, "polarity must be 'positive' or 'negative'")
    h = habit_service.create(
        db, name=name, polarity=polarity, color=body.get("color"),
    )
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@router.patch("/habits/{habit_id}")
def habits_patch(habit_id: int, body: dict, db: Session = Depends(get_db)):
    """Rename / recolor / archive. Body any of {name, color, polarity,
    sort_order, archived: bool}."""
    from ..services import habit_service
    h = habit_service.update(db, habit_id, **body)
    if not h:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@router.delete("/habits/{habit_id}")
def habits_delete(habit_id: int, db: Session = Depends(get_db)):
    """Hard delete. Entries cascade."""
    from ..services import habit_service
    ok = habit_service.delete(db, habit_id)
    if not ok:
        raise HTTPException(404, "habit not found")
    return {"deleted": True}


@router.put("/habits/{habit_id}/entries/{day}")
def habit_entry_upsert(
    habit_id: int, day: str, body: dict, db: Session = Depends(get_db),
):
    """Upsert one day's entry. Path `day` = YYYY-MM-DD. Body:
    {value: bool, note?: str}."""
    from ..services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    if "value" not in body:
        raise HTTPException(400, "value required (bool)")
    e = habit_service.upsert_entry(
        db, habit_id, d, bool(body["value"]), note=body.get("note"),
    )
    if not e:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_entry(e)


@router.delete("/habits/{habit_id}/entries/{day}")
def habit_entry_unlog(
    habit_id: int, day: str, db: Session = Depends(get_db),
):
    """Delete one day's entry — reverts to unknown."""
    from ..services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    deleted = habit_service.unlog_entry(db, habit_id, d)
    return {"deleted": deleted}
