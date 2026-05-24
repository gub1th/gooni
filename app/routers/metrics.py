from datetime import date as _date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..common import _parse_iso_date


router = APIRouter()

_VALID_METRIC_TYPES = ("calories", "protein", "weight", "exercise")


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
def metrics_cut_table(days: int = 30, db: Session = Depends(get_db)):
    """Per-day cut table for the dashboard. Returns rows (newest first) +
    today's running totals."""
    from ..services import daily_metric_service
    from datetime import datetime as _dt
    days = max(1, min(days, 365))
    end_d = _date.today()
    start_d = end_d - timedelta(days=days - 1)
    rows = daily_metric_service.cut_table(db, start_d, end_d)
    today = daily_metric_service.running_total_for_today(db)
    return {
        "rows": rows,
        "today": {"calories": today["calories"], "protein": today["protein"]},
        "updated_at": _dt.utcnow().isoformat(),
    }
