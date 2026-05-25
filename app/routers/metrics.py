from datetime import date as _date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..common import _parse_iso_date


router = APIRouter()

_VALID_METRIC_TYPES = (
    "calories", "protein", "weight", "exercise",
    "alcohol", "weed", "vape", "note",
)
# Types whose cut-table cell carries TEXT, not a number: exercise (label) +
# note (freeform). Everything else is numeric. Drives /metrics/cell mapping.
_TEXT_CELL_TYPES = ("exercise", "note")


@router.post("/metrics")
def metric_log(body: dict, db: Session = Depends(get_db)):
    """Manual / test log. Body: {metric_type, value, unit?, date?, notes?}.
    The live logging path is the chat fitness handler — this endpoint is
    for direct entry + verification."""
    from ..services import daily_metric_service
    metric_type = (body.get("metric_type") or "").strip().lower()
    if metric_type not in _VALID_METRIC_TYPES:
        raise HTTPException(400, f"metric_type must be one of {_VALID_METRIC_TYPES}")
    if body.get("value") is None:
        raise HTTPException(400, "value required")
    try:
        value = float(body["value"])
    except (TypeError, ValueError):
        raise HTTPException(400, "value must be a number")
    day = _parse_iso_date(body.get("date")) if body.get("date") else None
    row = daily_metric_service.log(
        db, metric_type, value,
        unit=body.get("unit"), day=day, notes=body.get("notes"),
    )
    return daily_metric_service.serialize(row)


@router.put("/metrics/cell")
def metric_set_cell(body: dict, db: Session = Depends(get_db)):
    """Excel-style cell edit for the cut table. Body:
    {date, metric_type, value?, text?}.

    Collapses the (date, metric_type) to a single canonical row (idempotent —
    backs the dashboard inline edit + the prod backfill). Numeric types read
    `value`; exercise/note read `text`. An empty/null value+text clears the
    cell (deletes the day's rows for that type)."""
    from ..services import daily_metric_service
    metric_type = (body.get("metric_type") or "").strip().lower()
    if metric_type not in _VALID_METRIC_TYPES:
        raise HTTPException(400, f"metric_type must be one of {_VALID_METRIC_TYPES}")
    day = _parse_iso_date(body.get("date"))
    if day is None:
        raise HTTPException(400, "valid date required (YYYY-MM-DD)")

    if metric_type in _TEXT_CELL_TYPES:
        text = (body.get("text") or "").strip() or None
        # exercise: presence sentinel (1.0) when a label is present; note:
        # value is irrelevant (0.0). Empty text → set_cell clears the cell.
        value = (1.0 if metric_type == "exercise" else 0.0) if text else None
        row = daily_metric_service.set_cell(db, day, metric_type, value=value, notes=text)
    else:
        raw = body.get("value")
        value: float | None = None
        if raw is not None and str(raw).strip() != "":
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(400, "value must be a number")
        row = daily_metric_service.set_cell(db, day, metric_type, value=value, unit=body.get("unit"))

    return {
        "cleared": row is None,
        "row": daily_metric_service.serialize(row) if row else None,
    }


@router.get("/metrics")
def metrics_list(start: str | None = None, end: str | None = None, db: Session = Depends(get_db)):
    """Raw rows in [start, end] (defaults to last 30 days). Debug/detail."""
    from ..services import daily_metric_service
    from ..db.models import DailyMetric
    end_d = _parse_iso_date(end) or _date.today()
    start_d = _parse_iso_date(start) or (end_d - timedelta(days=29))
    rows = (
        db.query(DailyMetric)
        .filter(DailyMetric.date >= start_d, DailyMetric.date <= end_d)
        .order_by(DailyMetric.date.desc(), DailyMetric.created_at.desc())
        .all()
    )
    return [daily_metric_service.serialize(r) for r in rows]


@router.get("/metrics/cut-table")
def metrics_cut_table(days: int = 30, fill: bool = False, db: Session = Depends(get_db)):
    """Per-day cut table for the dashboard. Returns rows (newest first) +
    today's running totals. `fill=true` emits empty rows for every day in
    the window (the continuous, clickable grid the editable view uses)."""
    from ..services import daily_metric_service
    from datetime import datetime as _dt
    days = max(1, min(days, 365))
    end_d = _date.today()
    start_d = end_d - timedelta(days=days - 1)
    rows = daily_metric_service.cut_table(db, start_d, end_d, fill_gaps=fill)
    today = daily_metric_service.running_total_for_today(db)
    return {
        "rows": rows,
        "today": {"calories": today["calories"], "protein": today["protein"]},
        "updated_at": _dt.utcnow().isoformat(),
    }
