"""Habit CRUD + streak computation.

Habits are daily binary trackers ("went to gym", "stayed clean from
vaping"). Each `(habit, date)` has at most one HabitEntry row; absence
of a row = unlogged / unknown. Explicit value=True means "I did the
thing"; explicit value=False means "I did NOT" — both break ambiguity.

Streak rule: walking backward from today's date, count consecutive days
where value=True. If today has no entry yet, the walk starts from
yesterday (one grace day) so the streak doesn't "drop" the moment
midnight passes. An explicit False or a gap > 1 day breaks the streak.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ..db.models import Habit, HabitEntry, Settings


def _today(db: Session) -> date:
    """Today's calendar date in Daniel's timezone — NOT server UTC.

    Fly runs in UTC; Daniel is Pacific. Using `date.today()` directly
    rolled the strip + streak to "tomorrow" every evening (e.g. Sun 8pm
    PT is already Mon in UTC), so the 7-day strip highlighted the wrong
    "today" and streaks could break a day early. Anchor on the same
    `Settings.nudge_tz` the daily scheduler uses.
    """
    s = db.query(Settings).filter(Settings.id == 1).first()
    tz_name = (s.nudge_tz if s and s.nudge_tz else "America/Los_Angeles")
    try:
        return datetime.now(ZoneInfo(tz_name)).date()
    except Exception:
        return datetime.utcnow().date()


# 10-color palette mirroring focus_service. Each new habit cycles through
# in creation order so users get visually distinct rows out of the box.
_COLOR_PALETTE = [
    "#22C55E", "#3B82F6", "#F59E0B", "#A855F7", "#EF4444",
    "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#14B8A6",
]


def _next_color(db: Session) -> str:
    n = db.query(Habit).count()
    return _COLOR_PALETTE[n % len(_COLOR_PALETTE)]


# ── habit CRUD ──────────────────────────────────────────────────────────


def list_active(db: Session) -> list[Habit]:
    return (
        db.query(Habit)
        .filter(Habit.archived_at.is_(None))
        .order_by(Habit.sort_order, Habit.id)
        .all()
    )


def get(db: Session, habit_id: int) -> Habit | None:
    return db.query(Habit).filter(Habit.id == habit_id).first()


def find_by_name(db: Session, name: str) -> Habit | None:
    """Case-insensitive exact match (LIKE without wildcards)."""
    return (
        db.query(Habit)
        .filter(Habit.name.ilike(name.strip()))
        .filter(Habit.archived_at.is_(None))
        .first()
    )


def find_by_name_fuzzy(db: Session, name: str) -> list[Habit]:
    """Case-insensitive substring match. Used by the chat tool so 'gym'
    resolves 'went to gym'. Returns all matches — caller refuses if
    ambiguous (>1 hit)."""
    pattern = f"%{name.strip()}%"
    return (
        db.query(Habit)
        .filter(Habit.name.ilike(pattern))
        .filter(Habit.archived_at.is_(None))
        .all()
    )


def create(
    db: Session,
    name: str,
    polarity: str = "positive",
    color: str | None = None,
) -> Habit:
    max_order = db.query(Habit).count()
    h = Habit(
        name=name.strip(),
        polarity=polarity,
        color=color or _next_color(db),
        sort_order=max_order,
    )
    db.add(h)
    db.commit()
    db.refresh(h)

    # G3 Habit→Focus binding: cosine-match the habit name against active
    # focuses, write `supports` edge if it clears the floor. Habit names
    # are short ("gym", "no smoke") so the threshold matches the standard
    # SUPPORTS_FLOOR; very generic names won't bind and that's fine.
    try:
        from .list_service import list_service
        from . import focus_binding
        name_embedding = list_service._embed_item_text(h.name)
        if name_embedding:
            focus_binding.bind_to_focus(
                db, src_kind="habit", src_id=h.id, embedding=name_embedding
            )
    except Exception as e:
        print(f"[habit_service] habit→focus bind failed: {e}")

    return h


def update(db: Session, habit_id: int, **patch: Any) -> Habit | None:
    h = get(db, habit_id)
    if not h:
        return None
    for key in ("name", "color", "polarity", "sort_order"):
        if key in patch and patch[key] is not None:
            setattr(h, key, patch[key])
    if "archived" in patch:
        h.archived_at = datetime.utcnow() if patch["archived"] else None
    db.commit()
    db.refresh(h)
    return h


def delete(db: Session, habit_id: int) -> bool:
    """Hard delete. Entries cascade via the FK ondelete=CASCADE."""
    h = get(db, habit_id)
    if not h:
        return False
    db.delete(h)
    db.commit()
    return True


# ── entry upsert / unlog ───────────────────────────────────────────────


def upsert_entry(
    db: Session, habit_id: int, day: date, value: bool, note: str | None = None,
) -> HabitEntry | None:
    """Insert-or-update a single day's entry. Returns the row or None
    if the habit doesn't exist.
    """
    h = get(db, habit_id)
    if not h:
        return None
    existing = (
        db.query(HabitEntry)
        .filter(HabitEntry.habit_id == habit_id, HabitEntry.date == day)
        .first()
    )
    if existing:
        existing.value = value
        if note is not None:
            existing.note = note
        db.commit()
        db.refresh(existing)
        return existing
    e = HabitEntry(habit_id=habit_id, date=day, value=value, note=note)
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def unlog_entry(db: Session, habit_id: int, day: date) -> bool:
    """Delete the entry for (habit, day). Reverts the day to unknown.
    Returns True if a row was deleted, False if it didn't exist.
    """
    row = (
        db.query(HabitEntry)
        .filter(HabitEntry.habit_id == habit_id, HabitEntry.date == day)
        .first()
    )
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True


# ── derived: streak + recent strip ──────────────────────────────────────


def _entries_by_date(
    db: Session, habit_id: int, since: date,
) -> dict[date, bool]:
    rows = (
        db.query(HabitEntry.date, HabitEntry.value)
        .filter(HabitEntry.habit_id == habit_id, HabitEntry.date >= since)
        .all()
    )
    return {row[0]: bool(row[1]) for row in rows}


def compute_streak(db: Session, habit_id: int) -> int:
    """Streak fork on polarity. True always means "did the literal action"
    regardless of polarity — only the streak metric changes.

    polarity='positive' (build a habit, e.g. "went to gym"):
        consecutive True walking backward from today. Today unlogged →
        start from yesterday (one grace day). Explicit False or a gap
        breaks.

    polarity='negative' (break a habit, e.g. "vaping"):
        days since last True (last slip) — sober-tracker pattern. No
        daily logging required. When no slip is recorded in the lookup
        window, count from habit creation so a brand-new habit reads
        "0d clean" instead of "400d".

    Lookup is bounded to the last 400 days — well past any practical
    streak length. Avoids unbounded scan.
    """
    today = _today(db)
    cutoff = today - timedelta(days=400)
    h = get(db, habit_id)
    if not h:
        return 0
    entries = _entries_by_date(db, habit_id, cutoff)

    if h.polarity == "negative":
        last_slip = max(
            (d for d, v in entries.items() if v is True),
            default=None,
        )
        if last_slip is None:
            baseline = h.created_at.date() if h.created_at else today
            return max(0, (today - baseline).days)
        return max(0, (today - last_slip).days)

    cursor = today
    if today not in entries:
        cursor = today - timedelta(days=1)

    streak = 0
    while cursor >= cutoff:
        val = entries.get(cursor)
        if val is True:
            streak += 1
            cursor -= timedelta(days=1)
        else:
            break
    return streak


def recent_strip(
    db: Session, habit_id: int, days: int = 7,
) -> list[dict]:
    """Most-recent N days ordered oldest → newest. Each cell:
       {"date": "YYYY-MM-DD", "value": True | False | None}.
    None = unlogged.
    """
    today = _today(db)
    earliest = today - timedelta(days=days - 1)
    entries = _entries_by_date(db, habit_id, earliest)
    out: list[dict] = []
    for offset in range(days - 1, -1, -1):
        d = today - timedelta(days=offset)
        out.append({
            "date": d.isoformat(),
            "value": entries.get(d),
        })
    return out


# ── serialization ───────────────────────────────────────────────────────


def serialize_habit(h: Habit, include_derived: bool = False, db: Session | None = None) -> dict:
    base = {
        "id": h.id,
        "name": h.name,
        "color": h.color,
        "polarity": h.polarity,
        "archived_at": h.archived_at.isoformat() if h.archived_at else None,
        "sort_order": h.sort_order,
        "created_at": h.created_at.isoformat() if h.created_at else None,
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
    }
    if include_derived and db is not None:
        base["streak"] = compute_streak(db, h.id)
        base["recent"] = recent_strip(db, h.id, days=7)
    return base


def serialize_entry(e: HabitEntry) -> dict:
    return {
        "id": e.id,
        "habit_id": e.habit_id,
        "date": e.date.isoformat(),
        "value": bool(e.value),
        "note": e.note,
    }
