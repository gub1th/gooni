"""Focus system service — the persistence logic behind the MCP tools and the
glanceable dashboard (PRD `gooni-focus-system-plan.md`, 2026-07-23).

Claude is the intelligence layer (extraction, intent, batching judgment); this
module is deterministic persistence: topic resolution, the 30-minute batch
rule, salience bump-on-write / decay-on-read, and reminder CRUD. No LLM here.

Datetimes are naive-UTC to match the rest of app/db/models.py (Column defaults
are datetime.utcnow). User-facing "today" for reminder-day filtering goes
through common.local_today so it honors Settings.nudge_tz.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import (
    Person,
    Reminder,
    Thought,
    ThoughtBatch,
    Topic,
)

# ── Tuning constants ─────────────────────────────────────────────────────────

# Salience decays exponentially with a 7-day half-life: a topic untouched for
# a week shows at half its stored salience, three weeks at an eighth. Chosen so
# the dashboard's top-5 turns over on the timescale Daniel actually context-
# switches, not faster (jittery) or slower (stale).
SALIENCE_HALF_LIFE_DAYS = 7.0
# Floor so nothing ever fully disappears — but see DISPLAY_CUTOFF for the
# dashboard's finite-list cutoff.
SALIENCE_FLOOR = 0.01
SALIENCE_CEIL = 0.99
# How much a single write bumps stored salience toward the ceiling. Additive,
# then clamped — a burst of thoughts on one topic saturates rather than
# runs away.
SALIENCE_BUMP = 0.08
# New topics start mid-range so a first thought immediately reads as live.
SALIENCE_SEED = 0.30

# Same-topic thoughts within this window append to the open batch; a larger
# gap opens a new one.
BATCH_GAP_MINUTES = 30
# A topic touched within this window pulses on the dashboard (growth signal).
GROWTH_WINDOW_HOURS = 24
# Dashboard shows at most this many circles (five slots, auto-ranked).
DASHBOARD_SLOTS = 5

# Palette assigned round-robin to new topics (matches the mockup's per-topic
# identity colors). Color is per-topic identity, not meaning.
_TOPIC_PALETTE = [
    "#AFA9EC",  # violet
    "#85B7EB",  # blue
    "#B4B2A9",  # stone
    "#EF9F27",  # amber
    "#F09595",  # rose
    "#7FC8A9",  # sage
    "#E0C36B",  # gold
    "#C99BD8",  # orchid
]


# ── Decay ────────────────────────────────────────────────────────────────────


def decay_factor(last_touched: datetime, now: datetime | None = None) -> float:
    """Exponential decay multiplier in (0, 1] from time since last write.

    Pure + side-effect-free so it's unit-testable in isolation. now defaults
    to utcnow(); pass it explicitly in tests for determinism.
    """
    now = now or datetime.utcnow()
    elapsed_days = max(0.0, (now - last_touched).total_seconds() / 86400.0)
    return 0.5 ** (elapsed_days / SALIENCE_HALF_LIFE_DAYS)


def decayed_salience(
    stored: float, last_touched: datetime, now: datetime | None = None
) -> float:
    """Displayed salience = stored × decay, floored at SALIENCE_FLOOR."""
    return max(SALIENCE_FLOOR, stored * decay_factor(last_touched, now))


# ── Topics ───────────────────────────────────────────────────────────────────


def _next_color(db: Session) -> str:
    """Round-robin the palette by current topic count so new topics get
    distinct-ish colors without a random source (Math.random is unavailable
    in some runtimes and non-deterministic in tests)."""
    idx = db.query(Topic).count() % len(_TOPIC_PALETTE)
    return _TOPIC_PALETTE[idx]


def resolve_topic(db: Session, name: str) -> Topic | None:
    """Case-insensitive exact-name lookup. Returns None if absent."""
    name = (name or "").strip()
    if not name:
        return None
    return (
        db.query(Topic)
        .filter(func_lower(Topic.name) == name.lower())
        .order_by(Topic.id.asc())
        .first()
    )


def create_topic(db: Session, name: str, parent: str | None = None) -> Topic:
    """Create a topic (idempotent on name). `parent` is a parent topic NAME —
    resolved/created so Claude can pass a human name, not an id."""
    name = (name or "").strip()
    if not name:
        raise ValueError("topic name required")
    existing = resolve_topic(db, name)
    if existing:
        return existing

    parent_id = None
    if parent and parent.strip():
        parent_topic = resolve_topic(db, parent) or create_topic(db, parent)
        parent_id = parent_topic.id

    topic = Topic(
        name=name,
        parent_id=parent_id,
        salience=SALIENCE_SEED,
        last_touched=datetime.utcnow(),
        color=_next_color(db),
    )
    db.add(topic)
    db.flush()
    return topic


def bump_salience(db: Session, topic: Topic, now: datetime | None = None) -> None:
    """A write to the topic: raise stored salience toward the ceiling and
    reset the decay anchor to now."""
    now = now or datetime.utcnow()
    topic.salience = min(SALIENCE_CEIL, (topic.salience or 0.0) + SALIENCE_BUMP)
    topic.last_touched = now


def list_topics(db: Session, now: datetime | None = None) -> list[dict]:
    """All topics with decayed salience + growth flag, ranked hottest-first."""
    now = now or datetime.utcnow()
    growth_cutoff = now - timedelta(hours=GROWTH_WINDOW_HOURS)
    rows = db.query(Topic).all()
    out = [_topic_dict(t, now, growth_cutoff) for t in rows]
    out.sort(key=lambda d: d["salience_decayed"], reverse=True)
    return out


def _topic_dict(topic: Topic, now: datetime, growth_cutoff: datetime) -> dict:
    return {
        "id": topic.id,
        "name": topic.name,
        "parent_id": topic.parent_id,
        "color": topic.color,
        "salience_stored": round(topic.salience, 4),
        "salience_decayed": round(
            decayed_salience(topic.salience, topic.last_touched, now), 4
        ),
        "last_touched": _iso(topic.last_touched),
        "growth": topic.last_touched >= growth_cutoff,
    }


# ── Thoughts + batching ──────────────────────────────────────────────────────


def log_thought(
    db: Session,
    content: str,
    topic_name: str,
    new_batch: bool = False,
    label: str | None = None,
    now: datetime | None = None,
) -> dict:
    """THE core write. Resolve (or create) the topic, apply the 30-minute
    batch rule, insert the thought, bump the topic's salience.

    Returns the created thought + its batch + the (post-bump, decayed) topic.
    """
    content = (content or "").strip()
    if not content:
        raise ValueError("thought content required")
    now = now or datetime.utcnow()

    topic = resolve_topic(db, topic_name) or create_topic(db, topic_name)

    batch = None if new_batch else _open_batch(db, topic.id, now)
    if batch is None:
        batch = ThoughtBatch(
            topic_id=topic.id,
            label=(label or _snippet(content)),
            started_at=now,
            ended_at=now,
        )
        db.add(batch)
        db.flush()
    else:
        batch.ended_at = now
        if label:  # Claude can refine the running batch's summary
            batch.label = label

    thought = Thought(content=content, timestamp=now, batch_id=batch.id)
    db.add(thought)
    db.flush()

    bump_salience(db, topic, now)
    db.flush()

    growth_cutoff = now - timedelta(hours=GROWTH_WINDOW_HOURS)
    return {
        "thought": {"id": thought.id, "content": thought.content, "timestamp": _iso(thought.timestamp)},
        "batch": {"id": batch.id, "label": batch.label, "topic_id": batch.topic_id},
        "topic": _topic_dict(topic, now, growth_cutoff),
    }


def _open_batch(db: Session, topic_id: int, now: datetime) -> ThoughtBatch | None:
    """The topic's most-recent batch if it's still inside the 30-min window."""
    batch = (
        db.query(ThoughtBatch)
        .filter(ThoughtBatch.topic_id == topic_id)
        .order_by(ThoughtBatch.ended_at.desc())
        .first()
    )
    if batch and (now - batch.ended_at) <= timedelta(minutes=BATCH_GAP_MINUTES):
        return batch
    return None


def query_thoughts(
    db: Session,
    topic: str | None = None,
    since: datetime | None = None,
    text: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Read thoughts, newest-first, filtered by topic name / recency / substring."""
    q = db.query(Thought, ThoughtBatch, Topic).join(
        ThoughtBatch, Thought.batch_id == ThoughtBatch.id
    ).join(Topic, ThoughtBatch.topic_id == Topic.id)

    if topic and topic.strip():
        q = q.filter(func_lower(Topic.name) == topic.strip().lower())
    if since:
        q = q.filter(Thought.timestamp >= since)
    if text and text.strip():
        q = q.filter(Thought.content.ilike(f"%{text.strip()}%"))

    rows = q.order_by(Thought.timestamp.desc()).limit(min(limit, 200)).all()
    return [
        {
            "id": th.id,
            "content": th.content,
            "timestamp": _iso(th.timestamp),
            "topic": tp.name,
            "batch_id": b.id,
            "batch_label": b.label,
        }
        for th, b, tp in rows
    ]


# ── People + reminders ───────────────────────────────────────────────────────


def resolve_person(db: Session, name: str) -> Person:
    """Get-or-create a person by name (case-insensitive)."""
    name = (name or "").strip()
    person = (
        db.query(Person)
        .filter(func_lower(Person.name) == name.lower())
        .order_by(Person.id.asc())
        .first()
    )
    if person:
        return person
    person = Person(name=name, first_seen=datetime.utcnow())
    db.add(person)
    db.flush()
    return person


def set_reminder(
    db: Session,
    content: str,
    due_at: datetime | None = None,
    owed_to: str | None = None,
    from_thought: int | None = None,
) -> dict:
    """Create a reminder or promise. If `owed_to` (a person name) is set the
    row is typed 'promise' and the person is resolved/created."""
    content = (content or "").strip()
    if not content:
        raise ValueError("reminder content required")

    owed_id = None
    rtype = "reminder"
    if owed_to and owed_to.strip():
        owed_id = resolve_person(db, owed_to).id
        rtype = "promise"

    reminder = Reminder(
        type=rtype,
        content=content,
        owed_to=owed_id,
        due_at=due_at,
        thought_id=from_thought,
        done=False,
    )
    db.add(reminder)
    db.flush()
    return _reminder_dict(db, reminder)


def list_reminders(
    db: Session, day: datetime | None = None, include_done: bool = False
) -> list[dict]:
    """Open reminders. If `day` is given, restrict dated reminders to that
    calendar day (undated promises always pass through — they surface by age).
    Ordered: dated by due time, then undated by age (oldest first)."""
    q = db.query(Reminder)
    if not include_done:
        q = q.filter(Reminder.done.is_(False))
    if day is not None:
        start = datetime(day.year, day.month, day.day)
        end = start + timedelta(days=1)
        q = q.filter(
            (Reminder.due_at.is_(None)) | ((Reminder.due_at >= start) & (Reminder.due_at < end))
        )
    rows = q.all()

    def _sort_key(r: Reminder):
        # Dated first (by time), then undated (by created_at asc = oldest first).
        return (0, r.due_at) if r.due_at is not None else (1, r.created_at)

    rows.sort(key=_sort_key)
    return [_reminder_dict(db, r) for r in rows]


def set_reminder_done(db: Session, reminder_id: int, done: bool = True) -> dict | None:
    reminder = db.query(Reminder).filter(Reminder.id == reminder_id).first()
    if reminder is None:
        return None
    reminder.done = done
    db.flush()
    return _reminder_dict(db, reminder)


def _reminder_dict(db: Session, r: Reminder) -> dict:
    owed_name = None
    if r.owed_to is not None:
        person = db.query(Person).filter(Person.id == r.owed_to).first()
        owed_name = person.name if person else None
    age_days = max(0, (datetime.utcnow() - r.created_at).days)
    return {
        "id": r.id,
        "type": r.type,
        "content": r.content,
        "owed_to": owed_name,  # null = owed to self
        "due_at": _iso(r.due_at),
        "done": r.done,
        "age_days": age_days,
        "thought_id": r.thought_id,
    }


# ── Dashboard assembly ───────────────────────────────────────────────────────


def dashboard(db: Session, now: datetime | None = None) -> dict:
    """One payload for the glanceable display. Google Calendar events are
    merged CLIENT-SIDE (the plan forbids syncing gcal into SQLite) — this
    returns only Gooni-owned data.

    - circles: top-5 topics by decayed salience (size), with growth (pulse)
    - notch.reminders: dated reminders, time-ordered (client merges gcal)
    - notch.promises: promises, age-ordered (oldest = most at-risk first)
    - log: recent batch labels with timestamps
    """
    now = now or datetime.utcnow()
    topics = list_topics(db, now)
    reminders = list_reminders(db)

    notch_reminders = [r for r in reminders if r["type"] == "reminder"]
    notch_promises = [r for r in reminders if r["type"] == "promise"]
    # Promises surface by age — oldest first (most at risk of quietly breaking).
    notch_promises.sort(key=lambda r: r["age_days"], reverse=True)

    log_rows = (
        db.query(ThoughtBatch, Topic)
        .join(Topic, ThoughtBatch.topic_id == Topic.id)
        .order_by(ThoughtBatch.ended_at.desc())
        .limit(12)
        .all()
    )
    log = [
        {
            "batch_id": b.id,
            "label": b.label,
            "topic": tp.name,
            "color": tp.color,
            "ended_at": _iso(b.ended_at),
        }
        for b, tp in log_rows
    ]

    return {
        "circles": topics[:DASHBOARD_SLOTS],
        "overflow_topics": topics[DASHBOARD_SLOTS:],  # for displacement notices
        "notch": {"reminders": notch_reminders, "promises": notch_promises},
        "log": log,
        "generated_at": _iso(now),
    }


# ── Seed ─────────────────────────────────────────────────────────────────────


def seed_topics(db: Session) -> list[Topic]:
    """Seed the current topics if the table is empty. Idempotent — a no-op
    once topics exist. Names/colors mirror the dashboard mockup; Daniel
    renames / adds / removes via create_topic afterward."""
    if db.query(Topic).count() > 0:
        return []
    seeds = [
        ("Gooni", "#AFA9EC"),
        ("Job search", "#85B7EB"),
        ("Craft", "#B4B2A9"),
        ("Focus cam", "#EF9F27"),
        ("Buys", "#F09595"),
    ]
    created = []
    now = datetime.utcnow()
    for name, color in seeds:
        t = Topic(name=name, salience=SALIENCE_SEED, last_touched=now, color=color)
        db.add(t)
        created.append(t)
    db.flush()
    return created


# ── helpers ──────────────────────────────────────────────────────────────────


def _snippet(text: str, n: int = 48) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


# SQLite is case-sensitive on = by default; lower() both sides for name lookups.
from sqlalchemy import func as _sa_func  # noqa: E402


def func_lower(col):
    return _sa_func.lower(col)
