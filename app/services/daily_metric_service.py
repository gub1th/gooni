"""DailyMetric CRUD + cut-table aggregation.

Module-style (no class), mirroring habit_service — callers do
`from ..services import daily_metric_service` then call the functions.

The fitness handler (intent_handlers/fitness.py) writes rows in real time
as Daniel logs food/weight/exercise on chat. The metrics router exposes
the aggregated cut table for the dashboard. "Today" defaults resolve in
Daniel's configured TZ via `common.local_today` — NOT `date.today()`,
which on the UTC server rolls to tomorrow after ~5pm PT and lands logs on
the wrong calendar day.
"""

from __future__ import annotations

from datetime import date as _date, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..common import local_today
from ..db.models import DailyMetric


# Metric types that sum within a day. Used by running_total + cut_table.
_ADDITIVE_TYPES = ("calories", "protein")
# Numeric types where the newest row wins (vs additive). Weight is a
# weigh-in; alcohol/weed/vape are per-day counts the cut-table cell edit
# sets directly (chat doesn't log them, so "newest wins" == "the value
# you typed"). Substance streaks ("N days no weed") are derivable from
# row history later — no Habit needed; keeps the cut table one system.
_LAST_VALUE_TYPES = ("weight", "alcohol", "weed", "vape")
# `note` = freeform per-day annotation (newest text wins). `exercise` =
# presence sentinel + label. Full set of columns the cut table renders.
_CELL_TYPES = (
    "calories", "protein", "weight", "exercise",
    "alcohol", "weed", "vape", "note",
)


def log(
    db: Session,
    metric_type: str,
    value: float,
    unit: str | None = None,
    day: _date | None = None,
    notes: str | None = None,
) -> DailyMetric:
    """Insert one metric row. `day` defaults to today in Daniel's TZ."""
    row = DailyMetric(
        metric_type=metric_type,
        value=float(value),
        unit=unit,
        date=day or local_today(db),
        notes=notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def running_total_for_today(db: Session, day: _date | None = None) -> dict:
    """Sum of additive metrics for `day` (default today). The number the
    fitness ack renders ("1,165 cal, 77g so far today")."""
    d = day or local_today(db)
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
    d = day or local_today(db)
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


def set_cell(
    db: Session,
    day: _date,
    metric_type: str,
    value: float | None = None,
    unit: str | None = None,
    notes: str | None = None,
) -> DailyMetric | None:
    """Excel-style cell edit / backfill: collapse a (day, metric_type) to a
    single canonical row.

    Deletes any existing rows for that day+type, then inserts ONE row with
    the given value/notes. Returns the row, or None when the cell is cleared
    (value is None AND notes empty → delete only). Distinct from log(), which
    is additive (chat logging multiple foods sums them): this is the manual
    override path, so it's naturally idempotent — re-running a backfill sets
    the same value rather than stacking duplicate rows.
    """
    db.query(DailyMetric).filter(
        DailyMetric.date == day,
        DailyMetric.metric_type == metric_type,
    ).delete(synchronize_session=False)
    cleared = value is None and not (notes and notes.strip())
    if cleared:
        db.commit()
        return None
    row = DailyMetric(
        metric_type=metric_type,
        value=float(value or 0.0),
        unit=unit,
        date=day,
        notes=(notes.strip() if notes else None),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _empty_bucket() -> dict:
    return {
        "calories": 0.0, "protein": 0.0, "weight": None,
        "exercise": False, "exercise_label": None,
        "alcohol": None, "weed": None, "vape": None, "note": None,
    }


def cut_table(
    db: Session, start: _date, end: _date, fill_gaps: bool = False,
) -> list[dict]:
    """Per-day aggregation over [start, end] inclusive, newest first.

    calories/protein = SUM; weight/alcohol/weed/vape = the day's most-recent
    value; exercise = whether any exercise row exists that day (+ its label);
    note = the day's most-recent freeform text. The window is bounded
    (default 30 days) so pulling all rows and folding in Python is cheap and
    keeps the "last value" logic simple (no window-function gymnastics).

    `fill_gaps=True` emits an empty row for every day in the window that has
    no data — the continuous grid the editable dashboard view needs so blank
    days are clickable. The read-only/ambient view leaves it False so it
    stays compact (only days with data).
    """
    rows = (
        db.query(DailyMetric)
        .filter(DailyMetric.date >= start, DailyMetric.date <= end)
        .order_by(DailyMetric.date.asc(), DailyMetric.created_at.asc(), DailyMetric.id.asc())
        .all()
    )
    by_day: dict[_date, dict] = {}
    if fill_gaps:
        d = start
        while d <= end:
            by_day[d] = _empty_bucket()
            d += timedelta(days=1)
    for r in rows:
        bucket = by_day.setdefault(r.date, _empty_bucket())
        if r.metric_type in _ADDITIVE_TYPES:
            bucket[r.metric_type] += float(r.value or 0)
        elif r.metric_type in _LAST_VALUE_TYPES:
            # rows are asc by created_at, so the last seen wins.
            bucket[r.metric_type] = float(r.value or 0)
        elif r.metric_type == "exercise":
            bucket["exercise"] = True
            if r.notes:
                bucket["exercise_label"] = r.notes
        elif r.metric_type == "note":
            bucket["note"] = r.notes

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
            "alcohol": b["alcohol"],
            "weed": b["weed"],
            "vape": b["vape"],
            "note": b["note"],
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
