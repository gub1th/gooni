"""DailyMetric CRUD + cut-table aggregation.

Module-style (no class), mirroring habit_service — callers do
`from ..services import daily_metric_service` then call the functions.

The fitness handler (intent_handlers/fitness.py) writes rows in real time
as Daniel logs food/weight/exercise on chat. The metrics router exposes
the aggregated cut table for the dashboard. All time math is on the
server's local calendar date (same convention as habit_service) — `date`
is a calendar Date, so timezones don't shift which day a log lands on.
"""

from __future__ import annotations

from datetime import date as _date, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import DailyMetric


# Metric types that sum within a day (vs weight = last-write-wins,
# exercise = presence). Used by running_total + cut_table.
_ADDITIVE_TYPES = ("calories", "protein")


def log(
    db: Session,
    metric_type: str,
    value: float,
    unit: str | None = None,
    day: _date | None = None,
    notes: str | None = None,
) -> DailyMetric:
    """Insert one metric row. `day` defaults to today (server local)."""
    row = DailyMetric(
        metric_type=metric_type,
        value=float(value),
        unit=unit,
        date=day or _date.today(),
        notes=notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def running_total_for_today(db: Session, day: _date | None = None) -> dict:
    """Sum of additive metrics for `day` (default today). The number the
    fitness ack renders ("1,165 cal, 77g so far today")."""
    d = day or _date.today()
    rows = (
        db.query(DailyMetric.metric_type, func.sum(DailyMetric.value))
        .filter(
            DailyMetric.date == d,
            DailyMetric.metric_type.in_(_ADDITIVE_TYPES),
        )
        .group_by(DailyMetric.metric_type)
        .all()
    )
    totals = {mt: float(s or 0) for mt, s in rows}
    return {
        "date": d.isoformat(),
        "calories": totals.get("calories", 0.0),
        "protein": totals.get("protein", 0.0),
    }


def update_most_recent(
    db: Session,
    metric_type: str,
    new_value: float,
    day: _date | None = None,
) -> DailyMetric | None:
    """Correction flow. "actually that chicken was ~900 cal" overwrites
    the most-recent (metric_type, day) row's value in place and leaves a
    breadcrumb in notes. Returns the row, or None if there's nothing to
    correct (caller falls back to a fresh log)."""
    d = day or _date.today()
    row = (
        db.query(DailyMetric)
        .filter(DailyMetric.metric_type == metric_type, DailyMetric.date == d)
        .order_by(DailyMetric.created_at.desc(), DailyMetric.id.desc())
        .first()
    )
    if row is None:
        return None
    old = row.value
    row.value = float(new_value)
    trail = f"corrected {old:g}→{float(new_value):g}"
    row.notes = f"{row.notes} ({trail})" if row.notes else trail
    db.commit()
    db.refresh(row)
    return row


def cut_table(db: Session, start: _date, end: _date) -> list[dict]:
    """Per-day aggregation over [start, end] inclusive, newest first.

    calories/protein = SUM; weight = the day's most-recent value;
    exercise = whether any exercise row exists that day (+ its label).
    The window is bounded (default 30 days) so pulling all rows and
    folding in Python is cheap and keeps the weight "last value" logic
    simple (no window-function gymnastics across SQLite).
    """
    rows = (
        db.query(DailyMetric)
        .filter(DailyMetric.date >= start, DailyMetric.date <= end)
        .order_by(DailyMetric.date.asc(), DailyMetric.created_at.asc(), DailyMetric.id.asc())
        .all()
    )
    by_day: dict[_date, dict] = {}
    for r in rows:
        bucket = by_day.setdefault(
            r.date,
            {"calories": 0.0, "protein": 0.0, "weight": None,
             "exercise": False, "exercise_label": None},
        )
        if r.metric_type == "calories":
            bucket["calories"] += float(r.value or 0)
        elif r.metric_type == "protein":
            bucket["protein"] += float(r.value or 0)
        elif r.metric_type == "weight":
            # rows are asc by created_at, so the last seen wins.
            bucket["weight"] = float(r.value or 0)
        elif r.metric_type == "exercise":
            bucket["exercise"] = True
            if r.notes:
                bucket["exercise_label"] = r.notes

    out: list[dict] = []
    for d in sorted(by_day.keys(), reverse=True):
        b = by_day[d]
        out.append({
            "date": d.isoformat(),
            "calories": round(b["calories"], 1),
            "protein": round(b["protein"], 1),
            "weight": b["weight"],
            "exercise": b["exercise"],
            "exercise_label": b["exercise_label"],
        })
    return out


def serialize(m: DailyMetric) -> dict:
    return {
        "id": m.id,
        "metric_type": m.metric_type,
        "value": m.value,
        "unit": m.unit,
        "date": m.date.isoformat() if m.date else None,
        "notes": m.notes,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }
