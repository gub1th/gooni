"""Trackable + TrackableEntry CRUD — the generic measurement primitive
(ambient-loop v2 Slice 2).

Module-style like habit_service / daily_metric_service. A Trackable is a
definition (name, kind, agg rule, optional target); a TrackableEntry is
one value on one calendar day. Multiple entries per (trackable, day) are
legal — reads fold per the definition's `agg`:

  sum  → additive within a day (calories: each meal is one entry)
  last → newest entry wins (weight, substances, freeform notes)

`kind` picks the live value column: boolean → value_boolean, numeric →
value_numeric, json → value_json. value_json is ALSO a free sidecar on
boolean/numeric entries (labels, per-entry units) — schema_hint describes
payloads but nothing validates them; runtime tolerates loose data.

The fitness-specific semantics (running totals, food ledger, cut-table
shape) live in daily_metric_service, which is now an adapter over these
rows. This module stays domain-agnostic.
"""

from __future__ import annotations

import json
from datetime import date as _date, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..common import local_today
from ..db.models import Trackable, TrackableEntry

VALID_KINDS = ("boolean", "numeric", "json")
VALID_AGGS = ("sum", "last")

# Sources walled off from every generic trackable-listing surface (the log
# matrix, daily-dots glance, activity rail, overlay, chat read_trackable). The
# rows still store idiomatically in Trackable/TrackableEntry — they're just
# invisible to the shared read paths and read ONLY via their own surface.
# focus_cam = the local webcam focus sidecar (served via /focus/cam/*). This is
# a stronger version of the client-side `source=shortcuts` drop: enforced at the
# query so no client can accidentally surface it.
HIDDEN_SOURCES = ("focus_cam",)


def _norm_name(name: str) -> str:
    return (name or "").strip().lower()


def get_by_name(db: Session, name: str) -> Trackable | None:
    n = _norm_name(name)
    if not n:
        return None
    return db.query(Trackable).filter(Trackable.name == n).first()


def get(db: Session, trackable_id: int) -> Trackable | None:
    return db.query(Trackable).filter(Trackable.id == trackable_id).first()


def list_all(db: Session, *, include_hidden: bool = False) -> list[Trackable]:
    """All trackable definitions, name-sorted. Excludes HIDDEN_SOURCES
    (walled-off surfaces like focus_cam) unless `include_hidden=True` — so the
    matrix/dots/overlay/chat callers that ride this stay clean by default while
    an explicit debug/admin read can still see everything."""
    q = db.query(Trackable)
    if not include_hidden:
        q = q.filter(Trackable.source.notin_(HIDDEN_SOURCES))
    return q.order_by(Trackable.name.asc()).all()


def create(
    db: Session,
    *,
    name: str,
    kind: str = "numeric",
    unit: str | None = None,
    cadence: str | None = None,
    target: float | None = None,
    is_important: bool = False,
    agg: str | None = None,
    schema_hint: dict | str | None = None,
    source: str = "manual",
    parent_promise_id: int | None = None,
) -> Trackable:
    """Insert a definition. Name is lowercase-unique — an existing row
    with the same name is returned untouched (idempotent get-or-create,
    so feeds and chat can call this blind)."""
    n = _norm_name(name)
    if not n:
        raise ValueError("name required")
    existing = get_by_name(db, n)
    if existing is not None:
        return existing
    if kind not in VALID_KINDS:
        kind = "numeric"
    if agg is None:
        agg = "last"
    if agg not in VALID_AGGS:
        agg = "last"
    if isinstance(schema_hint, dict):
        schema_hint = json.dumps(schema_hint)
    t = Trackable(
        name=n,
        kind=kind,
        unit=unit,
        cadence=cadence,
        target=target,
        is_important=bool(is_important),
        agg=agg,
        schema_hint=schema_hint,
        source=source,
        parent_promise_id=parent_promise_id,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


_UNSET: Any = object()


def update(
    db: Session,
    trackable_id: int,
    *,
    unit: Any = _UNSET,
    cadence: Any = _UNSET,
    target: Any = _UNSET,
    is_important: bool | None = None,
    schema_hint: Any = _UNSET,
    parent_promise_id: Any = _UNSET,
) -> Trackable | None:
    t = get(db, trackable_id)
    if t is None:
        return None
    if unit is not _UNSET:
        t.unit = unit
    if cadence is not _UNSET:
        t.cadence = cadence
    if target is not _UNSET:
        t.target = float(target) if target is not None else None
    if is_important is not None:
        t.is_important = bool(is_important)
    if schema_hint is not _UNSET:
        t.schema_hint = (
            json.dumps(schema_hint) if isinstance(schema_hint, dict) else schema_hint
        )
    if parent_promise_id is not _UNSET:
        t.parent_promise_id = parent_promise_id
    db.commit()
    db.refresh(t)
    return t


def log_entry(
    db: Session,
    trackable: Trackable | int | str,
    *,
    day: _date | None = None,
    value_boolean: bool | None = None,
    value_numeric: float | None = None,
    value_json: dict | str | None = None,
    source: str = "manual",
    replace: bool = False,
) -> TrackableEntry | None:
    """Insert one entry. `trackable` accepts a row, id, or name.

    replace=False (default) appends — the natural shape for additive
    logging and last-wins reads alike. replace=True collapses the
    (trackable, day) to this single row first (the Excel-style cell
    override / backfill path — idempotent). A replace with no value at
    all just clears the cell and returns None.
    """
    t = _resolve(db, trackable)
    if t is None:
        raise ValueError(f"unknown trackable: {trackable!r}")
    d = day or local_today(db)

    if replace:
        db.query(TrackableEntry).filter(
            TrackableEntry.trackable_id == t.id,
            TrackableEntry.date == d,
        ).delete(synchronize_session=False)
        cleared = (
            value_boolean is None
            and value_numeric is None
            and not _json_has_content(value_json)
        )
        if cleared:
            db.commit()
            return None

    e = TrackableEntry(
        trackable_id=t.id,
        date=d,
        value_boolean=value_boolean,
        value_numeric=float(value_numeric) if value_numeric is not None else None,
        value_json=(
            json.dumps(value_json) if isinstance(value_json, dict) else value_json
        ),
        source=source,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _json_has_content(v: dict | str | None) -> bool:
    if isinstance(v, dict):
        return bool(v)
    return bool(v and str(v).strip())


def _resolve(db: Session, trackable: Trackable | int | str) -> Trackable | None:
    if isinstance(trackable, Trackable):
        return trackable
    if isinstance(trackable, int):
        return get(db, trackable)
    return get_by_name(db, str(trackable))


def entries_for(
    db: Session,
    trackable: Trackable | int | str,
    *,
    start: _date,
    end: _date,
) -> list[TrackableEntry]:
    t = _resolve(db, trackable)
    if t is None:
        return []
    return (
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


def day_value(entries: list[TrackableEntry], t: Trackable) -> Any:
    """Fold one day's entries per the definition's kind + agg. Returns a
    float (numeric), bool (boolean), parsed JSON (json kind), or None."""
    if not entries:
        return None
    if t.kind == "numeric":
        vals = [e.value_numeric for e in entries if e.value_numeric is not None]
        if not vals:
            return None
        return float(sum(vals)) if t.agg == "sum" else float(vals[-1])
    if t.kind == "boolean":
        vals = [e.value_boolean for e in entries if e.value_boolean is not None]
        return bool(vals[-1]) if vals else None
    # json — newest payload wins
    for e in reversed(entries):
        if e.value_json:
            try:
                return json.loads(e.value_json)
            except (TypeError, ValueError):
                return e.value_json
    return None


def day_label(entries: list[TrackableEntry]) -> str | None:
    """The freeform label riding on a day's entries (newest wins) — the
    `value_json.label` sidecar used to tag a boolean day ("exercise → push").
    Returns None when no entry carries a non-empty string label."""
    for e in reversed(entries):
        if not e.value_json:
            continue
        try:
            payload = json.loads(e.value_json)
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict):
            lbl = payload.get("label")
            if isinstance(lbl, str) and lbl.strip():
                return lbl.strip()
    return None


def pivot(
    db: Session,
    trackable: Trackable | int | str,
    *,
    days: int = 30,
    end: _date | None = None,
    fill_gaps: bool = False,
) -> list[dict]:
    """Per-day fold over the last `days` days, newest first — the
    cut-table-style read for one trackable."""
    t = _resolve(db, trackable)
    if t is None:
        return []
    end_d = end or local_today(db)
    start_d = end_d - timedelta(days=max(0, days - 1))
    rows = entries_for(db, t, start=start_d, end=end_d)
    by_day: dict[_date, list[TrackableEntry]] = {}
    for e in rows:
        by_day.setdefault(e.date, []).append(e)
    if fill_gaps:
        d = start_d
        while d <= end_d:
            by_day.setdefault(d, [])
            d += timedelta(days=1)
    out = []
    for d in sorted(by_day.keys(), reverse=True):
        out.append({
            "date": d.isoformat(),
            "value": day_value(by_day[d], t),
            "label": day_label(by_day[d]),
            "entry_count": len(by_day[d]),
        })
    return out


def serialize(t: Trackable) -> dict:
    hint = None
    if t.schema_hint:
        try:
            hint = json.loads(t.schema_hint)
        except (TypeError, ValueError):
            hint = t.schema_hint
    return {
        "id": t.id,
        "name": t.name,
        "kind": t.kind,
        "unit": t.unit,
        "cadence": t.cadence,
        "target": t.target,
        "is_important": bool(t.is_important),
        "agg": t.agg,
        "schema_hint": hint,
        "source": t.source,
        "parent_promise_id": t.parent_promise_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def serialize_entry(e: TrackableEntry) -> dict:
    vj = None
    if e.value_json:
        try:
            vj = json.loads(e.value_json)
        except (TypeError, ValueError):
            vj = e.value_json
    return {
        "id": e.id,
        "trackable_id": e.trackable_id,
        "date": e.date.isoformat() if e.date else None,
        "value_boolean": e.value_boolean,
        "value_numeric": e.value_numeric,
        "value_json": vj,
        "source": e.source,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }
