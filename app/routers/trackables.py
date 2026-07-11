"""Trackable + TrackableEntry routes (ambient-loop v2 Slice 2).

The generic measurement surface. Fitness-specific reads (cut table,
running totals) stay on /metrics — those routes are the legacy-shaped
adapter over the same rows.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..common import _parse_iso_date
from ..db.database import get_db

router = APIRouter()


@router.post("/trackables")
def trackable_create(body: dict, db: Session = Depends(get_db)):
    """Create a definition. Body: {name, kind?, unit?, cadence?, target?,
    is_important?, agg?, schema_hint?, source?, parent_promise_id?}.
    Name-idempotent: posting an existing name returns that row."""
    from ..services import trackable_service

    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    kind = body.get("kind") or "numeric"
    if kind not in trackable_service.VALID_KINDS:
        raise HTTPException(400, f"kind must be one of {trackable_service.VALID_KINDS}")
    agg = body.get("agg")
    if agg is not None and agg not in trackable_service.VALID_AGGS:
        raise HTTPException(400, f"agg must be one of {trackable_service.VALID_AGGS}")
    t = trackable_service.create(
        db,
        name=name,
        kind=kind,
        unit=body.get("unit"),
        cadence=body.get("cadence"),
        target=body.get("target"),
        is_important=bool(body.get("is_important")),
        agg=agg,
        schema_hint=body.get("schema_hint"),
        source=body.get("source") or "manual",
        parent_promise_id=body.get("parent_promise_id"),
    )
    return trackable_service.serialize(t)


@router.get("/trackables")
def trackable_list(db: Session = Depends(get_db)):
    from ..services import trackable_service

    return [trackable_service.serialize(t) for t in trackable_service.list_all(db)]


@router.patch("/trackables/{trackable_id}")
def trackable_patch(trackable_id: int, body: dict, db: Session = Depends(get_db)):
    """Edit a definition. Any subset of {unit, cadence, target,
    is_important, schema_hint, parent_promise_id}."""
    from ..services import trackable_service

    kwargs: dict = {}
    for key in ("unit", "cadence", "target", "schema_hint", "parent_promise_id"):
        if key in body:
            kwargs[key] = body.get(key)
    if "is_important" in body:
        kwargs["is_important"] = bool(body.get("is_important"))
    if not kwargs:
        raise HTTPException(400, "nothing to update")
    t = trackable_service.update(db, trackable_id, **kwargs)
    if t is None:
        raise HTTPException(404, "Trackable not found")
    return trackable_service.serialize(t)


@router.post("/trackables/{trackable_id}/entries")
def trackable_log_entry(trackable_id: int, body: dict, db: Session = Depends(get_db)):
    """Log one entry. Body: {date?, value_boolean?, value_numeric?,
    value_json?, source?, replace?}. Default append; replace=true collapses
    the (trackable, day) to this row (cell-edit semantics)."""
    from ..services import trackable_service

    t = trackable_service.get(db, trackable_id)
    if t is None:
        raise HTTPException(404, "Trackable not found")
    day = _parse_iso_date(body.get("date")) if body.get("date") else None
    e = trackable_service.log_entry(
        db,
        t,
        day=day,
        value_boolean=body.get("value_boolean"),
        value_numeric=body.get("value_numeric"),
        value_json=body.get("value_json"),
        source=body.get("source") or "manual",
        replace=bool(body.get("replace")),
    )
    return {
        "cleared": e is None,
        "entry": trackable_service.serialize_entry(e) if e else None,
    }


@router.get("/trackables/{trackable_id}/entries")
def trackable_entries(
    trackable_id: int,
    days: int = 30,
    fill: bool = False,
    raw: bool = False,
    end: str | None = None,
    db: Session = Depends(get_db),
):
    """Per-day pivot for `days` days ending at `end` (newest first) — the
    cut-table-style read. `end` (YYYY-MM-DD) defaults to today; pass an older
    date to page backwards for the log matrix's infinite scroll. `raw=true`
    returns individual entries instead."""
    from datetime import timedelta

    from ..common import local_today
    from ..services import trackable_service

    t = trackable_service.get(db, trackable_id)
    if t is None:
        raise HTTPException(404, "Trackable not found")
    days = max(1, min(days, 365))
    end_d = _parse_iso_date(end) if end else local_today(db)
    if raw:
        start_d = end_d - timedelta(days=days - 1)
        rows = trackable_service.entries_for(db, t, start=start_d, end=end_d)
        return {
            "trackable": trackable_service.serialize(t),
            "entries": [trackable_service.serialize_entry(e) for e in rows],
        }
    return {
        "trackable": trackable_service.serialize(t),
        "days": trackable_service.pivot(db, t, days=days, end=end_d, fill_gaps=fill),
    }
