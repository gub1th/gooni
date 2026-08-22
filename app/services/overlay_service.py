"""Ambient overlay data (Slice 4) — the hover-summoned "what matters
right now" surface. FOUR zones, each built by a DETERMINISTIC rule
cascade (no LLM, no scores Daniel can't reproduce in his head). Every
entry carries a `reason` string so the ranking is explicable per item.

Zones:
  action_horizon  — active Promises: overdue → due ≤48h → important.
  trackables_today— active Trackables + today's met/missed/pending.
  anchor          — the single pinned Note (Settings.overlay_anchor_note_id).
  whoop_select    — Daniel-picked whoop-source Trackables (Slice 5 feeds).

Empty zones return [] / None; the FE hides their frames.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..common import local_today
from ..db.models import Note, Promise, Settings, Trackable, TrackableEntry

HORIZON_HOURS = 48
HORIZON_CAP = 8
TRACKABLE_ACTIVE_DAYS = 14
TRACKABLE_CAP = 10


def build_overlay(db: Session) -> dict:
    settings = db.query(Settings).first()
    return {
        "action_horizon": _action_horizon(db),
        "trackables_today": _trackables_today(db),
        "anchor": _anchor(db, settings),
        "whoop_select": _whoop_select(db, settings),
    }


def _action_horizon(db: Session) -> list[dict]:
    """Rule cascade over ACTIVE promises:
      1. overdue          (inferred_due < now)        — oldest due first
      2. due_soon         (due within HORIZON_HOURS)  — soonest first
      3. important        (is_important, not already placed) — newest first
    Capped at HORIZON_CAP."""
    from . import promise_service

    now = datetime.utcnow()
    cutoff = now + timedelta(hours=HORIZON_HOURS)
    active = (
        db.query(Promise)
        .filter(Promise.state == "active")
        .all()
    )

    overdue = sorted(
        [p for p in active if p.inferred_due and p.inferred_due < now],
        key=lambda p: p.inferred_due,
    )
    due_soon = sorted(
        [p for p in active if p.inferred_due and now <= p.inferred_due <= cutoff],
        key=lambda p: p.inferred_due,
    )
    placed = {p.id for p in overdue} | {p.id for p in due_soon}
    important = sorted(
        [p for p in active if p.is_important and p.id not in placed],
        key=lambda p: p.created_at or now,
        reverse=True,
    )

    out: list[dict] = []
    for reason, rows in (("overdue", overdue), ("due_soon", due_soon), ("important", important)):
        for p in rows:
            if len(out) >= HORIZON_CAP:
                return out
            entry = promise_service.serialize(p)
            entry["reason"] = reason
            out.append(entry)
    return out


def _direction(t: Trackable) -> str:
    """Target direction: 'limit' (stay under — calories) or 'floor'
    (reach it — protein). Reads schema_hint.direction when set; falls
    back to the one known floor-shaped system metric. Deterministic."""
    if t.schema_hint:
        try:
            d = json.loads(t.schema_hint).get("direction")
            if d in ("limit", "floor"):
                return d
        except (TypeError, ValueError):
            pass
    return "floor" if t.name == "protein" else "limit"


def _trackables_today(db: Session) -> list[dict]:
    """Active trackables (is_important OR an entry in the last
    TRACKABLE_ACTIVE_DAYS) + today's status:
      pending — nothing logged today
      logged  — value logged, no target to judge against
      met     — target set and satisfied per direction
      missed  — target set and violated (only meaningful for limits;
                a floor not yet reached stays 'pending-ish' → 'logged')
    Important first, then name. Capped at TRACKABLE_CAP."""
    from . import trackable_service

    today = local_today(db)
    since = today - timedelta(days=TRACKABLE_ACTIVE_DAYS)

    defs = trackable_service.list_all(db)
    recent_ids = {
        tid
        for (tid,) in (
            db.query(TrackableEntry.trackable_id)
            .filter(TrackableEntry.date >= since)
            .distinct()
            .all()
        )
    }
    active = [t for t in defs if t.is_important or t.id in recent_ids]
    active.sort(key=lambda t: (not t.is_important, t.name))

    out: list[dict] = []
    for t in active[:TRACKABLE_CAP]:
        entries = trackable_service.entries_for(db, t, start=today, end=today)
        value = trackable_service.day_value(entries, t)
        if value is None:
            status, reason = "pending", "nothing logged today"
        elif t.target is None or t.kind != "numeric":
            status, reason = "logged", "logged today (no numeric target)"
        else:
            direction = _direction(t)
            if direction == "limit":
                ok = float(value) <= float(t.target)
                status = "met" if ok else "missed"
                reason = f"{value:g} vs limit {t.target:g}"
            else:
                ok = float(value) >= float(t.target)
                # A floor not yet reached mid-day isn't a miss — the day
                # isn't over. It reads as still-in-progress.
                status = "met" if ok else "logged"
                reason = f"{value:g} vs floor {t.target:g}"
        out.append({
            "id": t.id,
            "name": t.name,
            "kind": t.kind,
            "unit": t.unit,
            "target": t.target,
            "is_important": bool(t.is_important),
            "value": value,
            "status": status,
            "reason": reason,
        })
    return out


def _anchor(db: Session, settings: Settings | None) -> dict | None:
    note_id = settings.overlay_anchor_note_id if settings else None
    if not note_id:
        return None
    # An archived anchor renders as NO anchor rather than as itself. The
    # anchor is the overlay's most prominent note slot, so it's the last place
    # an archived note should keep showing; the setting is left pointing at it
    # so unarchiving restores the anchor without re-picking.
    from ..serializers import _not_archived

    note = _not_archived(db.query(Note)).filter(Note.id == note_id).first()
    if note is None:
        return None
    return {
        "id": note.id,
        "title": note.title,
        "excerpt": note.excerpt,
    }


def _whoop_select(db: Session, settings: Settings | None) -> list[dict]:
    """Daniel-picked subset of whoop-source trackables + today's value.
    Empty until Slice 5 lands the whoop → Trackable feed."""
    from . import trackable_service

    raw = settings.overlay_whoop_keys if settings else "[]"
    try:
        keys = [k for k in json.loads(raw or "[]") if isinstance(k, str)]
    except (TypeError, ValueError):
        keys = []
    if not keys:
        return []
    today = local_today(db)
    out: list[dict] = []
    for key in keys:
        t = trackable_service.get_by_name(db, key)
        if t is None:
            continue
        entries = trackable_service.entries_for(db, t, start=today, end=today)
        out.append({
            "id": t.id,
            "name": t.name,
            "unit": t.unit,
            "value": trackable_service.day_value(entries, t),
        })
    return out
