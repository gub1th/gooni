"""Fitness-semantics adapter over Trackable/TrackableEntry (Slice 2).

DailyMetric's table is dead (rows migrated in f3b8d1c6a9e2; drop lands in
the Slice 6 nuke) — but its SEMANTICS live on here: additive calories/
protein, last-wins weight/substances, exercise presence + label, freeform
day notes, the correction flows, and the cut-table pivot shape.

Public function signatures + return shapes are unchanged from the
DailyMetric era, so the chat fitness handler, /metrics routes, state_block
food ledger, and the CutTableSection FE all keep working. Storage mapping:

  metric_type      → Trackable (by name; seeded in the migration)
  value            → value_numeric (calories/protein/weight)
                     value_boolean (exercise/alcohol/weed/vape; >0 = True)
  notes            → value_json {"label": …} (or {"text": …} for `note`)
  unit             → value_json {"unit": …} (definition carries default)

"Today" defaults resolve in Daniel's TZ via `common.local_today` — NOT
`date.today()`, which on the UTC server rolls to tomorrow after ~5pm PT.
"""

from __future__ import annotations

import json
import re
from datetime import date as _date, timedelta

from sqlalchemy.orm import Session

from ..common import local_today
from ..db.models import Trackable, TrackableEntry

# Metric types that sum within a day. Used by running_total + cut_table.
_ADDITIVE_TYPES = ("calories", "protein")
# update_most_recent appends a "(corrected X→Y)" breadcrumb to a row's
# label. Strip it before grouping the food ledger so a corrected row stays
# folded with its original item instead of splitting into a phantom entry.
_CORRECTION_TRAIL_RE = re.compile(r"\s*\(corrected [^)]*\)\s*$")
# Numeric types where the newest row wins (vs additive).
_LAST_VALUE_TYPES = ("weight", "alcohol", "weed", "vape")
# Boolean-backed types (entry lands in value_boolean).
_BOOLEAN_TYPES = ("exercise", "alcohol", "weed", "vape")
# Full set of columns the cut table renders.
_CELL_TYPES = (
    "calories", "protein", "weight", "exercise",
    "alcohol", "weed", "vape", "note",
)

# Definition defaults for lazy get-or-create (mirror of the migration
# seed, so a fresh DB that never ran with data still self-heals).
_SYSTEM_DEFS = {
    "calories": ("numeric", "kcal", "sum"),
    "protein": ("numeric", "g", "sum"),
    "weight": ("numeric", "lb", "last"),
    "exercise": ("boolean", None, "last"),
    "alcohol": ("boolean", None, "last"),
    "weed": ("boolean", None, "last"),
    "vape": ("boolean", None, "last"),
    "note": ("json", None, "last"),
}


def _trackable(db: Session, metric_type: str) -> Trackable:
    """Resolve a system trackable by metric-type name, creating it from
    the defaults table if missing (idempotent)."""
    from . import trackable_service

    t = trackable_service.get_by_name(db, metric_type)
    if t is not None:
        return t
    kind, unit, agg = _SYSTEM_DEFS.get(metric_type, ("numeric", None, "last"))
    return trackable_service.create(
        db, name=metric_type, kind=kind, unit=unit, agg=agg, source="chat"
    )


def _sidecar(notes: str | None, unit: str | None, metric_type: str) -> str | None:
    payload: dict = {}
    if metric_type == "note":
        payload["text"] = notes or ""
    elif notes:
        payload["label"] = notes
    if unit:
        payload["unit"] = unit
    return json.dumps(payload) if payload else None


def _label_of(e: TrackableEntry) -> str | None:
    if not e.value_json:
        return None
    try:
        payload = json.loads(e.value_json)
    except (TypeError, ValueError):
        return None
    return payload.get("label") or payload.get("text")


def _unit_of(e: TrackableEntry) -> str | None:
    if not e.value_json:
        return None
    try:
        return json.loads(e.value_json).get("unit")
    except (TypeError, ValueError):
        return None


def log(
    db: Session,
    metric_type: str,
    value: float,
    unit: str | None = None,
    day: _date | None = None,
    notes: str | None = None,
) -> TrackableEntry:
    """Insert one entry (additive append). `day` defaults to today in
    Daniel's TZ. Returns the TrackableEntry row."""
    from . import trackable_service

    t = _trackable(db, metric_type)
    e = trackable_service.log_entry(
        db,
        t,
        day=day or local_today(db),
        value_boolean=(bool(value and float(value) > 0) if metric_type in _BOOLEAN_TYPES else None),
        value_numeric=(float(value) if metric_type not in (*_BOOLEAN_TYPES, "note") else None),
        value_json=_sidecar(notes, unit, metric_type),
        source="chat",
    )
    e._metric_type = metric_type  # serialize() hint — not persisted
    return e


def running_total_for_today(db: Session, day: _date | None = None) -> dict:
    """Sum of additive metrics for `day` (default today). The number the
    fitness ack renders ("1,165 cal, 77g so far today")."""
    d = day or local_today(db)
    totals = {"calories": 0.0, "protein": 0.0}
    for mt in _ADDITIVE_TYPES:
        t = _trackable(db, mt)
        rows = (
            db.query(TrackableEntry.value_numeric)
            .filter(TrackableEntry.trackable_id == t.id, TrackableEntry.date == d)
            .all()
        )
        totals[mt] = float(sum(v or 0 for (v,) in rows))
    return {
        "date": d.isoformat(),
        "calories": totals["calories"],
        "protein": totals["protein"],
    }


def today_food_ledger(db: Session, day: _date | None = None) -> dict:
    """Per-item food breakdown for `day`: every logged food with its
    calories + protein, plus the day total. Folds calorie+protein entries
    on their label (correction trail stripped) — same reconstruction the
    DailyMetric era used, now over value_json labels."""
    d = day or local_today(db)
    items: list[dict] = []
    by_label: dict[str, dict] = {}
    for mt in _ADDITIVE_TYPES:
        t = _trackable(db, mt)
        rows = (
            db.query(TrackableEntry)
            .filter(TrackableEntry.trackable_id == t.id, TrackableEntry.date == d)
            .order_by(TrackableEntry.created_at.asc(), TrackableEntry.id.asc())
            .all()
        )
        for r in rows:
            label = _CORRECTION_TRAIL_RE.sub("", (_label_of(r) or "").strip()).strip() or "(unlabeled)"
            item = by_label.get(label)
            if item is None:
                item = {"label": label, "calories": 0.0, "protein": 0.0}
                by_label[label] = item
                items.append(item)
            item[mt] += float(r.value_numeric or 0)
    for it in items:
        it["calories"] = round(it["calories"], 1)
        it["protein"] = round(it["protein"], 1)
    return {
        "date": d.isoformat(),
        "items": items,
        "calories": round(sum(i["calories"] for i in items), 1),
        "protein": round(sum(i["protein"] for i in items), 1),
    }


def update_most_recent(
    db: Session,
    metric_type: str,
    new_value: float,
    day: _date | None = None,
) -> TrackableEntry | None:
    """Correction flow. "actually that chicken was ~900 cal" overwrites
    the most-recent (metric_type, day) entry's value in place and leaves
    a breadcrumb in the label. Returns the entry, or None if there's
    nothing to correct (caller falls back to a fresh log)."""
    d = day or local_today(db)
    t = _trackable(db, metric_type)
    row = (
        db.query(TrackableEntry)
        .filter(TrackableEntry.trackable_id == t.id, TrackableEntry.date == d)
        .order_by(TrackableEntry.created_at.desc(), TrackableEntry.id.desc())
        .first()
    )
    if row is None:
        return None
    old = row.value_numeric or 0.0
    row.value_numeric = float(new_value)
    trail = f"corrected {old:g}→{float(new_value):g}"
    try:
        payload = json.loads(row.value_json) if row.value_json else {}
    except (TypeError, ValueError):
        payload = {}
    label = payload.get("label")
    payload["label"] = f"{label} ({trail})" if label else trail
    row.value_json = json.dumps(payload)
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
) -> TrackableEntry | None:
    """Excel-style cell edit / backfill: collapse a (day, metric_type) to
    a single canonical entry. Empty value+notes clears the cell. Distinct
    from log(), which is additive — this is the manual override path, so
    it's naturally idempotent."""
    from . import trackable_service

    t = _trackable(db, metric_type)
    cleared = value is None and not (notes and notes.strip())
    if cleared:
        return trackable_service.log_entry(db, t, day=day, replace=True, source="manual")
    e = trackable_service.log_entry(
        db,
        t,
        day=day,
        value_boolean=(bool(value and float(value) > 0) if metric_type in _BOOLEAN_TYPES else None),
        value_numeric=(float(value or 0.0) if metric_type not in (*_BOOLEAN_TYPES, "note") else None),
        value_json=_sidecar(notes.strip() if notes else None, unit, metric_type),
        source="manual",
        replace=True,
    )
    if e is not None:
        e._metric_type = metric_type  # serialize() hint — not persisted
    return e


def _empty_bucket() -> dict:
    return {
        "calories": 0.0, "protein": 0.0, "weight": None,
        "exercise": False, "exercise_label": None,
        "alcohol": None, "weed": None, "vape": None, "note": None,
    }


def list_entries(db: Session, start: _date, end: _date) -> list[dict]:
    """Raw entries across all system metric types in [start, end], newest
    first, rendered in the legacy row shape (backs GET /metrics)."""
    out: list[tuple] = []
    for mt in _CELL_TYPES:
        t = _trackable(db, mt)
        rows = (
            db.query(TrackableEntry)
            .filter(
                TrackableEntry.trackable_id == t.id,
                TrackableEntry.date >= start,
                TrackableEntry.date <= end,
            )
            .all()
        )
        out.extend((mt, r) for r in rows)
    out.sort(key=lambda p: (p[1].date, p[1].created_at or p[1].date), reverse=True)
    return [serialize(r, metric_type=mt) for mt, r in out]


def cut_table(
    db: Session, start: _date, end: _date, fill_gaps: bool = False,
) -> list[dict]:
    """Per-day aggregation over [start, end] inclusive, newest first.
    Same output shape as the DailyMetric era (CutTableSection contract):
    calories/protein = SUM; weight/alcohol/weed/vape = last value (booleans
    render as 1.0/None); exercise = presence + label; note = latest text.
    `fill_gaps=True` emits an empty row for every day in the window."""
    by_day: dict[_date, dict] = {}
    if fill_gaps:
        d = start
        while d <= end:
            by_day[d] = _empty_bucket()
            d += timedelta(days=1)

    for mt in _CELL_TYPES:
        t = _trackable(db, mt)
        rows = (
            db.query(TrackableEntry)
            .filter(
                TrackableEntry.trackable_id == t.id,
                TrackableEntry.date >= start,
                TrackableEntry.date <= end,
            )
            .order_by(
                TrackableEntry.date.asc(),
                TrackableEntry.created_at.asc(),
                TrackableEntry.id.asc(),
            )
            .all()
        )
        for r in rows:
            bucket = by_day.setdefault(r.date, _empty_bucket())
            if mt in _ADDITIVE_TYPES:
                bucket[mt] += float(r.value_numeric or 0)
            elif mt == "weight":
                if r.value_numeric is not None:
                    bucket["weight"] = float(r.value_numeric)
            elif mt in ("alcohol", "weed", "vape"):
                # Legacy cut-table cells are floats (1.0) or None.
                bucket[mt] = 1.0 if r.value_boolean else None
            elif mt == "exercise":
                if r.value_boolean:
                    bucket["exercise"] = True
                    label = _label_of(r)
                    if label:
                        bucket["exercise_label"] = label
            elif mt == "note":
                bucket["note"] = _label_of(r)

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


def serialize(e: TrackableEntry, metric_type: str | None = None) -> dict:
    """Legacy DailyMetric row shape, reconstructed from an entry — keeps
    the /metrics routes' response contract stable through the cutover."""
    if metric_type is None:
        metric_type = getattr(e, "_metric_type", None) or str(e.trackable_id)
    if e.value_numeric is not None:
        value = e.value_numeric
    elif e.value_boolean is not None:
        value = 1.0 if e.value_boolean else 0.0
    else:
        value = 0.0
    return {
        "id": e.id,
        "metric_type": metric_type,
        "value": value,
        "unit": _unit_of(e),
        "date": e.date.isoformat() if e.date else None,
        "notes": _label_of(e),
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }
