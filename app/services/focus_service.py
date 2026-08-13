"""Focus system service — an ADAPTER over the ambient-loop v2 primitives.

Same shape `daily_metric_service` has over Trackable: the focus vocabulary
(topics, thoughts, batches, reminders) is preserved at the seam, while the rows
underneath are ordinary Notes and Promises.

    Thought       → Note, tag `thought`, `parent_note_id` → its batch
    ThoughtBatch  → Note, tag `thought-batch`, title = Claude's label
    batch image   → Attachment (note-owned already)
    Reminder      → Promise + `owed_to` + `due_is_default`
    thought_id    → Edge `derives_from`
    Topic         → unchanged (identity + a decay curve nothing else models)
    Person        → unchanged (v2 has no person primitive at all)

WHY (2026-08-08): Claude reached Gooni through two connectors that wrote two
disconnected schemas, and the same commitments ended up in both — all four
`reminders` rows were verbatim twins of `promises` rows. Mark one kept and the
other stood active forever. Convergence makes one of them the record.

Every public function's SIGNATURE AND RETURN SHAPE is unchanged, so
`app/routers/focus.py`, both MCP servers, `FocusDashboard` and the kiosk needed
no edits. The response `id`s are now Note/Promise ids — nothing persists them
across requests, so the renumbering is invisible.

Still deterministic: decay, the batch rule, salience, bucketing. No LLM here.
Datetimes stay naive-UTC to match app/db/models.py; user-facing "today" goes
through common.local_today so it honors Settings.nudge_tz.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import date as _date, datetime, timedelta, timezone

from sqlalchemy.orm import Session, aliased

from ..common import local_now, parse_due_hint
from ..db.models import (
    Attachment,
    Note,
    Person,
    Promise,
    Topic,
)

log = logging.getLogger(__name__)

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

# The two Note subtypes this adapter owns. Tags (not columns) because that's
# how Note already carves out subtypes — `daily` for log notes, `sticky` for
# home-canvas notes. A LIKE against the JSON tags column answers "is this a
# thought" without a join, which is the documented pattern for low-cardinality
# per-note tags.
THOUGHT_TAG = "thought"
BATCH_TAG = "thought-batch"

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


# ── Note-subtype helpers ─────────────────────────────────────────────────────


def _tagged(query, tag: str):
    """Filter a Note query to rows carrying `tag`.

    `Note.tags` is a JSON-encoded list of lowercase strings, so a LIKE on the
    quoted token is an exact member test — `"thought"` can't partial-match
    `"thoughtful"` because the quotes bound it. This is the documented pattern
    for the tags column (low per-note cardinality, no join needed).
    """
    return query.filter(Note.tags.like(f'%"{tag}"%'))


def _tags_json(*tags: str) -> str:
    return json.dumps(list(tags))


def _embed_note_async(note_id: int) -> None:
    """Kick the note's embedding off-thread.

    `log_thought` is a hot path — Claude calls it mid-conversation — and an
    embedding round-trip inline would put ~200ms of OpenAI latency in front of
    every logged thought. `update_embedding` opens its own session, so it's
    safe to detach (same pattern as the /notes/{id}/embed route).

    Deliberately NOT `classify_note`: that runs the LLM signal extractor, which
    would mine Claude's own thought-logging for memories and feature requests.
    Thoughts are already curated by the thing writing them.

    NOTE: import the INSTANCE, not the module. `update_embedding` is a method
    on `NoteService`; `from . import note_service` binds the MODULE, whose
    attribute lookup raises AttributeError. That's exactly what happened here
    for the whole life of this function, and the handler below swallowed it
    into a `print` nobody read — so no logged thought was ever embedded and
    semantic search never returned one. Hence `log.exception`: this stays
    best-effort (a failed embed must not break a write) but it must be
    findable in the logs when it fails.
    """

    def _run():
        try:
            from .note_service import note_service

            note_service.update_embedding(note_id)
        except Exception as e:  # noqa: BLE001 — best-effort, never break a write
            log.exception(
                "thought embed failed for note %s: %s: %s",
                note_id,
                type(e).__name__,
                e,
            )

    threading.Thread(target=_run, daemon=True).start()


def _batch_image_urls(db: Session, note_ids: list[int]) -> dict[int, str]:
    """note_id → first attachment url, for a whole page of batch cards.

    One query for the set rather than one per card — `stream()` and the
    dashboard log both render a window of batches at once.
    """
    if not note_ids:
        return {}
    rows = (
        db.query(Attachment.note_id, Attachment.public_url)
        .filter(Attachment.note_id.in_(note_ids))
        .order_by(Attachment.id.asc())
        .all()
    )
    out: dict[int, str] = {}
    for note_id, url in rows:
        out.setdefault(note_id, url)  # first attachment wins
    return out


# ── Thoughts + batching ──────────────────────────────────────────────────────


def log_thought(
    db: Session,
    content: str,
    topic_name: str,
    new_batch: bool = False,
    label: str | None = None,
    image_url: str | None = None,
    now: datetime | None = None,
    at: datetime | None = None,
) -> dict:
    """THE core write. Resolve (or create) the topic, apply the 30-minute
    batch rule, insert the thought as a Note, bump the topic's salience.

    `at` BACKDATES the thought (2026-08-08). The timestamp used to be stamped
    at call time with no way to override it, so a session Claude logged an hour
    late showed an hour late — and the instructions had to work around the gap
    ("log the moment a thought lands"). A missing parameter isn't a law of
    physics. `now` still exists for test determinism; `at` is the caller-facing
    one and wins when both are passed.

    `image_url` pins an R2-hosted image to the batch card as an Attachment.
    Set on batch open; on append it overwrites only when provided (mirrors the
    label-refine rule) — a plain text thought never clears an existing image.

    Returns the created thought + its batch + the (post-bump, decayed) topic.
    """
    content = (content or "").strip()
    if not content:
        raise ValueError("thought content required")
    now = now or datetime.utcnow()
    stamp = at or now

    topic = resolve_topic(db, topic_name) or create_topic(db, topic_name)

    batch = None if new_batch else _open_batch(db, topic.id, stamp)
    if batch is None:
        batch = Note(
            title=(label or _snippet(content)),
            content="",
            excerpt=_snippet(content, 240),
            tags=_tags_json(BATCH_TAG),
            topic_id=topic.id,
            created_at=stamp,
            updated_at=stamp,
        )
        db.add(batch)
        db.flush()
    else:
        # `ended_at` — Note has no onupdate on updated_at, so the batch window
        # is advanced explicitly here.
        batch.updated_at = stamp
        if label:  # Claude can refine the running batch's summary
            batch.title = label
        if batch.topic_id is None:
            batch.topic_id = topic.id
    if image_url:
        _attach_image(db, batch.id, image_url)

    thought = Note(
        title=None,
        content=content,
        excerpt=_snippet(content, 240),
        tags=_tags_json(THOUGHT_TAG),
        topic_id=topic.id,
        parent_note_id=batch.id,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(thought)
    db.flush()

    bump_salience(db, topic, stamp)
    db.flush()

    _embed_note_async(thought.id)

    growth_cutoff = now - timedelta(hours=GROWTH_WINDOW_HOURS)
    return {
        "thought": {
            "id": thought.id,
            "content": thought.content,
            "timestamp": _iso(thought.created_at),
        },
        "batch": {
            "id": batch.id,
            "label": batch.title,
            "image_url": _batch_image_urls(db, [batch.id]).get(batch.id),
            "topic_id": batch.topic_id,
        },
        "topic": _topic_dict(topic, now, growth_cutoff),
    }


def _attach_image(db: Session, note_id: int, url: str) -> None:
    """Pin an already-uploaded R2 image to a batch card.

    Attachment is note-owned and carries a public_url, so the image card needs
    no column of its own — and unlike the old `ThoughtBatch.image_url`, it
    lands on a real Note, which means every note surface can render it.
    """
    existing = (
        db.query(Attachment)
        .filter(Attachment.note_id == note_id)
        .order_by(Attachment.id.asc())
        .first()
    )
    if existing is not None:
        existing.public_url = url
        db.flush()
        return
    filename = url.rsplit("/", 1)[-1] or "image"
    db.add(
        Attachment(
            note_id=note_id,
            filename=filename,
            # The bytes were uploaded by routers/focus.py; the extension is the
            # only type signal that survives the public URL.
            mime_type="image/png" if filename.lower().endswith(".png") else "image/jpeg",
            size_bytes=0,
            storage_key=url.split(".r2.dev/", 1)[-1] if ".r2.dev/" in url else filename,
            public_url=url,
        )
    )
    db.flush()


def _open_batch(db: Session, topic_id: int, now: datetime) -> Note | None:
    """The topic's most-recent batch if it's still inside the 30-min window."""
    batch = (
        _tagged(db.query(Note), BATCH_TAG)
        .filter(Note.topic_id == topic_id)
        .order_by(Note.updated_at.desc())
        .first()
    )
    if batch and batch.updated_at and (now - batch.updated_at) <= timedelta(
        minutes=BATCH_GAP_MINUTES
    ):
        return batch
    return None


def query_thoughts(
    db: Session,
    topic: str | None = None,
    since: datetime | None = None,
    text: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Read thoughts, newest-first, filtered by topic name / recency / substring.

    Still a substring match, deliberately: this is the tool Claude calls to
    check what it already logged, and an exact recall ("did I write down the
    Straia number") is better served by LIKE than by cosine. Thoughts are real
    Notes now, so semantic search over the same rows is available through
    `GET /notes/search` — two ways in, one store.
    """
    # Self-join: thoughts and their batches are both Notes, so the parent side
    # needs an alias or the tag filter would apply to both.
    Batch = aliased(Note)
    q = (
        _tagged(db.query(Note, Batch, Topic), THOUGHT_TAG)
        .outerjoin(Batch, Note.parent_note_id == Batch.id)
        .join(Topic, Note.topic_id == Topic.id)
    )

    if topic and topic.strip():
        q = q.filter(func_lower(Topic.name) == topic.strip().lower())
    if since:
        q = q.filter(Note.created_at >= since)
    if text and text.strip():
        q = q.filter(Note.content.ilike(f"%{text.strip()}%"))

    rows = q.order_by(Note.created_at.desc()).limit(min(limit, 200)).all()
    return [
        {
            "id": th.id,
            "content": th.content,
            "timestamp": _iso(th.created_at),
            "topic": tp.name,
            "batch_id": b.id if b is not None else None,
            "batch_label": b.title if b is not None else None,
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
    is_promise: bool = False,
) -> dict:
    """Create a commitment. Routed through `promise_service.create`, which is
    the point of the convergence: that path cosine-dedups at 0.85 against
    active promises, so re-stating a commitment through the connector now
    returns the existing row instead of minting the twin that put four
    duplicate pairs in prod.

    `is_promise` is accepted for signature compatibility but no longer changes
    what gets stored — in v2 every row in `promises` IS a promise. The display
    `type` is derived from `owed_to` (a commitment to another person reads
    differently from one to yourself); only the legacy `notch` payload sections
    on it, and nothing renders that anymore.

    An omitted `due_at` DEFAULTS to today's local EOD (flagged
    `due_is_default`) so the row can be placed on the short-term/longer-term
    split. A defaulted due never auto-breaks — see `Promise.due_is_default`.
    """
    content = (content or "").strip()
    if not content:
        raise ValueError("reminder content required")

    owed_id = None
    if owed_to and owed_to.strip():
        owed_id = resolve_person(db, owed_to).id

    # Every row gets a deadline. `parse_due_hint` is THE deadline parser
    # (app/common.py) — local-EOD anchored, converted to the naive-UTC storage
    # convention. Never grow a second resolver here.
    due_is_default = due_at is None
    if due_is_default:
        due_at = parse_due_hint("today", db)

    from . import promise_service

    # Dedup returns an EXISTING row, so remember the high-water mark to tell a
    # fresh insert from a match. Without this a re-statement would stomp a real
    # deadline with the defaulted one.
    max_id_before = db.query(_sa_func.max(Promise.id)).scalar() or 0
    promise = promise_service.create(
        db,
        utterance=content,
        summary=content,
        inferred_due=due_at,
        cadence="once",
    )
    is_new = promise.id > max_id_before

    if is_new:
        promise.due_is_default = due_is_default
        promise.owed_to = owed_id
    elif owed_id is not None:
        # Naming a creditor on a re-statement is new information; adopt it.
        promise.owed_to = owed_id
    db.flush()

    if from_thought:
        _link_thought(db, promise.id, int(from_thought))

    return _reminder_dict(db, promise)


def _link_thought(db: Session, promise_id: int, note_id: int) -> None:
    """Record that a commitment fell out of a logged thought.

    An Edge rather than a column: `edges` already models exactly this
    ((kind, id) → (kind, id) with a `derives_from` kind) and adding an FK per
    relation is what the table exists to prevent.
    """
    from . import edge_service

    try:
        edge_service.link(
            db,
            src_kind="promise",
            src_id=promise_id,
            dst_kind="note",
            dst_id=note_id,
            kind="derives_from",
        )
    except Exception as e:  # noqa: BLE001 — provenance is not worth a 500
        print(f"[focus] thought link failed (promise {promise_id}): {e}")


def _thought_ids(db: Session, promise_ids: list[int]) -> dict[int, int]:
    """promise_id → source note id, for a page of rows in one query."""
    if not promise_ids:
        return {}
    from ..db.models import Edge

    rows = (
        db.query(Edge.src_id, Edge.dst_id)
        .filter(
            Edge.src_kind == "promise",
            Edge.dst_kind == "note",
            Edge.kind == "derives_from",
            Edge.src_id.in_(promise_ids),
        )
        .all()
    )
    out: dict[int, int] = {}
    for src, dst in rows:
        out.setdefault(src, dst)
    return out


def _open_promises(db: Session):
    return db.query(Promise).filter(Promise.state == "active")


def list_reminders(
    db: Session,
    day: datetime | None = None,
    include_done: bool = False,
    state: str | None = None,
    limit: int | None = None,
) -> list[dict]:
    """Open commitments. If `day` is given, restrict dated rows to that
    calendar day (undated rows always pass through — they surface by age).
    Ordered: dated by due time, then undated by age (oldest first).

    `state` ("active" | "kept" | "broken" | "all") is the converged MCP
    surface's reader filter — it exists so ONE function answers both "what's
    open" and "what did I keep/break", which the old surface split across
    `list_reminders` (open only, rich shape) and `read_promises` (any state,
    a different shape). Two shapes for one table is how the schemas drifted in
    the first place. Omitted/None keeps the historical behaviour exactly:
    `include_done` decides, and every existing caller is untouched.
    """
    q = db.query(Promise)
    if state:
        if state != "all":
            q = q.filter(Promise.state == state)
    elif not include_done:
        q = q.filter(Promise.state == "active")
    if day is not None:
        start = datetime(day.year, day.month, day.day)
        end = start + timedelta(days=1)
        q = q.filter(
            (Promise.inferred_due.is_(None))
            | ((Promise.inferred_due >= start) & (Promise.inferred_due < end))
        )
    rows = q.all()

    def _sort_key(p: Promise):
        # Dated first (by time), then undated (by created_at asc = oldest first).
        return (0, p.inferred_due) if p.inferred_due is not None else (1, p.created_at)

    rows.sort(key=_sort_key)
    if limit is not None:
        rows = rows[: max(1, int(limit))]
    return _reminder_dicts(db, rows)


def set_reminder_done(db: Session, reminder_id: int, done: bool = True) -> dict | None:
    p = db.query(Promise).filter(Promise.id == reminder_id).first()
    if p is None:
        return None
    # Keep the lifecycle in sync with the legacy check-off: done = kept (a
    # reminder you tick off is a kept commitment), undone = back to active.
    _set_state(p, "kept" if done else "active")
    db.flush()
    return _reminder_dict(db, p)


VALID_STATES = ("active", "kept", "broken")


def _set_state(p: Promise, state: str, now: datetime | None = None) -> None:
    """Mutate a commitment's lifecycle state, stamping/clearing resolved_at."""
    now = now or datetime.utcnow()
    p.state = state
    p.resolved_at = None if state == "active" else now


def set_reminder_state(db: Session, reminder_id: int, state: str) -> dict | None:
    """Transition to active | kept | broken. Broken/kept stamp resolved_at
    (the "lasted Nd" anchor); reviving to active clears it."""
    if state not in VALID_STATES:
        raise ValueError(f"bad state {state!r}; expected one of {VALID_STATES}")
    p = db.query(Promise).filter(Promise.id == reminder_id).first()
    if p is None:
        return None
    _set_state(p, state)
    db.flush()
    return _reminder_dict(db, p)


def update_reminder(
    db: Session,
    reminder_id: int,
    *,
    content: str | None = None,
    due_at: datetime | None = None,
    clear_due: bool = False,
    owed_to: str | None = None,
    clear_owed: bool = False,
    cadence: str | None = None,
    cadence_target: int | None = None,
    is_important: bool | None = None,
) -> dict | None:
    """Edit a commitment's content / due / owed-to. Only provided fields change
    (None = "leave alone"); pass `clear_due` / `clear_owed` to explicitly reset
    a field — distinct from omitting it. `clear_due` resets to the today-EOD
    default rather than NULL (every row carries a date; a NULL falls out of both
    dashboard panels).

    Naming a person makes the display type read `promise`, and clearing the
    owner makes it read `reminder` again. This used to say "clearing the owner
    does NOT demote", which stopped being true at the convergence: `type` is
    DERIVED from `owed_to` in `_serialize_reminder` and nothing stores "was
    promoted once", so there is no state for a non-demotion to live in. It is
    cosmetic either way — `type` drives no surviving surface.

    State is untouched here — that rides set_reminder_state / set_reminder_done.
    """
    p = db.query(Promise).filter(Promise.id == reminder_id).first()
    if p is None:
        return None
    if content is not None:
        c = content.strip()
        if not c:
            raise ValueError("content cannot be empty")
        p.utterance = c
        p.summary = c[:200]
    if clear_due:
        # Explicitly clearing a due drops back to the default (today EOD) rather
        # than to NULL — every row carries a date now, and a NULL would fall out
        # of both dashboard panels entirely.
        p.inferred_due = parse_due_hint("today", db)
        p.due_is_default = True
    elif due_at is not None:
        p.inferred_due = due_at
        # You named this deadline, so it counts: it can now auto-break.
        p.due_is_default = False
    if clear_owed:
        p.owed_to = None
    elif owed_to is not None and owed_to.strip():
        p.owed_to = resolve_person(db, owed_to).id
    if cadence is not None:
        from . import promise_service

        if cadence not in promise_service.VALID_CADENCES:
            raise ValueError(f"bad cadence {cadence!r}")
        p.cadence = cadence
        # cadence_target only means anything for n_per_week; anything else
        # clears it rather than leaving a stale N behind a changed shape.
        p.cadence_target = (
            int(cadence_target)
            if cadence == "n_per_week" and cadence_target is not None
            else None
        )
        if cadence != "once" and due_at is None and not clear_due and p.due_is_default:
            # A recurring commitment carries no single deadline: a due on a
            # daily promise is a parse artifact (promise_service.create drops it
            # for the same reason). Only the DEFAULTED one is dropped — a
            # deadline someone actually named survives a cadence change.
            p.inferred_due = None
            p.due_is_default = False
    elif cadence_target is not None and p.cadence == "n_per_week":
        p.cadence_target = int(cadence_target)
    if is_important is not None:
        p.is_important = bool(is_important)
    db.flush()
    return _reminder_dict(db, p)


def delete_reminder(db: Session, reminder_id: int) -> bool:
    """Hard-delete a commitment. Delegates to promise_service so the row's
    edges go with it (the focus tables had no graph layer to clean up; Promise
    does)."""
    from . import promise_service

    return promise_service.delete(db, reminder_id)


def auto_break_overdue(db: Session, now: datetime | None = None) -> int:
    """Sweep commitments whose EXPLICIT due has passed while still active →
    broken. Returns the count broken.

    Two exclusions, both deliberate:
      - undated rows (legacy) — nothing to blow past.
      - `due_is_default` rows — since the ambient-dash rebuild every new
        commitment gets a due date, defaulted to today's EOD when nobody named
        one. Breaking those would mark Daniel broken at midnight on a deadline
        GOONI invented, every single night. A defaulted due is a placement hint
        for the dashboard, not a commitment. It rolls forward instead (see
        `_due_bucket`).

    Recurring cadences are excluded too — a deadline on a daily commitment is a
    parse artifact. That guard came with the v2 table and is new to this
    surface; the focus system never had recurring rows to protect.
    """
    now = now or datetime.utcnow()
    stale = (
        db.query(Promise)
        .filter(
            Promise.state == "active",
            Promise.inferred_due.isnot(None),
            Promise.due_is_default.is_(False),
            Promise.cadence == "once",
            Promise.inferred_due < now,
        )
        .all()
    )
    for p in stale:
        _set_state(p, "broken", now)
    if stale:
        db.flush()
    return len(stale)


def _reminder_dicts(db: Session, rows: list[Promise]) -> list[dict]:
    """Serialize a page of commitments, batching the two lookups the shape
    needs (creditor names, source-thought edges) instead of per-row queries."""
    if not rows:
        return []
    owed_ids = {p.owed_to for p in rows if p.owed_to is not None}
    names: dict[int, str] = {}
    if owed_ids:
        names = {
            pid: nm
            for pid, nm in db.query(Person.id, Person.name).filter(
                Person.id.in_(owed_ids)
            )
        }
    thoughts = _thought_ids(db, [p.id for p in rows])
    return [_serialize_reminder(p, names, thoughts) for p in rows]


def _reminder_dict(db: Session, p: Promise) -> dict:
    return _reminder_dicts(db, [p])[0]


def _serialize_reminder(
    p: Promise, names: dict[int, str], thoughts: dict[int, int]
) -> dict:
    now = datetime.utcnow()
    age_days = max(0, (now - p.created_at).days) if p.created_at else 0
    # "lasted" = how long the commitment stood: created → resolved (broken/kept),
    # or created → now while still active. Drives the broken card's warn meta.
    end = p.resolved_at if p.resolved_at is not None else now
    lasted_days = max(0, (end - p.created_at).days) if p.created_at else 0
    return {
        "id": p.id,
        # Derived, not stored: in v2 every row here is a promise. The split only
        # ever drove the legacy `notch` sectioning, and a commitment owed to
        # another person is the one that genuinely reads differently.
        "type": "promise" if p.owed_to is not None else "reminder",
        "content": p.summary or p.utterance,
        "owed_to": names.get(p.owed_to) if p.owed_to is not None else None,
        "due_at": _iso(p.inferred_due),
        "done": p.state != "active",
        "state": p.state,
        "resolved_at": _iso(p.resolved_at),
        "age_days": age_days,
        "lasted_days": lasted_days,
        "thought_id": thoughts.get(p.id),
        "due_is_default": bool(p.due_is_default),
        # Recurrence + importance live on the row and always have; they were
        # simply absent from this serializer because the focus system had no
        # concept of them. The converged MCP surface's `set_promise` writes
        # them, so ONE serializer has to be able to describe a whole commitment
        # — otherwise the in-process and over-HTTP gateways return different
        # keys for the same promise, which is the drift the convergence exists
        # to remove. Additive: existing consumers ignore unknown keys.
        "cadence": p.cadence,
        "cadence_target": p.cadence_target,
        "is_important": bool(p.is_important),
    }


# ── Stream (chronological arcs canvas) ───────────────────────────────────────

STREAM_DEFAULT_DAYS = 7
STREAM_MAX_DAYS = 60

# How much of a stream window the DEVICE derivation covers.
#
# Thought cards are read as cards — one row each, bounded by how many were
# written. Device rows are DERIVED from raw attention intervals, so their cost
# scales with how much the sensors recorded rather than with how many rows come
# out: a busy day is ~900 intervals per sensor, and `days` is caller-controlled
# up to STREAM_MAX_DAYS, so an unbounded derivation would materialise tens of
# thousands of rows for one request on a small VM.
#
# So the device half of the window is bounded independently, and stated here
# rather than applied silently: a stream longer than this still returns every
# thought card in it, and its `opened X` rows stop at the last
# DEVICE_STREAM_DAYS. The only in-repo caller (the day timeline) asks for one
# day; raise it if a surface ever needs device rows deeper than a week.
DEVICE_STREAM_DAYS = 7


def stream(
    db: Session,
    *,
    days: int = STREAM_DEFAULT_DAYS,
    end: _date | None = None,
    now: datetime | None = None,
) -> dict:
    """The arcs-canvas read: ONE day-bounded, newest-first chronological stream
    merging thought batch-cards + Shortcuts device-event cards — the merged
    said-vs-done timeline. Thoughts render as sentences (the batch label);
    events interleave quietly. Google Calendar is still merged CLIENT-side.

    Window = [end-(days-1), end] in LOCAL calendar days (Settings tz), so a
    late-night thought lands on the right day, not UTC-tomorrow. Each item:
      thought → {type, batch_id, topic, color, sentence, at, thought_count}
      event   → {type, label, kind, at, count}
    `at` is UTC-aware ISO (client converts to local).
    """
    now = now or datetime.utcnow()
    now_local = local_now(db)
    tz = now_local.tzinfo
    end_date = end or now_local.date()
    days = max(1, min(days, STREAM_MAX_DAYS))
    start_date = end_date - timedelta(days=days - 1)

    # Local-day window edges → naive-UTC bounds for the naive-UTC note columns.
    start_utc = (
        datetime.combine(start_date, datetime.min.time())
        .replace(tzinfo=tz)
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )
    end_utc = (
        datetime.combine(end_date + timedelta(days=1), datetime.min.time())
        .replace(tzinfo=tz)
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )

    rows = (
        _tagged(db.query(Note, Topic), BATCH_TAG)
        .join(Topic, Note.topic_id == Topic.id)
        .filter(Note.created_at >= start_utc, Note.created_at < end_utc)
        .order_by(Note.created_at.desc())
        .all()
    )
    batch_ids = [b.id for b, _ in rows]
    counts: dict[int, int] = {}
    if batch_ids:
        counts = dict(
            _tagged(db.query(Note.parent_note_id, _sa_func.count(Note.id)), THOUGHT_TAG)
            .filter(Note.parent_note_id.in_(batch_ids))
            .group_by(Note.parent_note_id)
            .all()
        )
    images = _batch_image_urls(db, batch_ids)

    items: list[dict] = [
        {
            "type": "thought",
            "batch_id": b.id,
            "topic": tp.name,
            "color": tp.color,
            "sentence": b.title,
            "image_url": images.get(b.id),
            "at": _iso(b.created_at),
            "thought_count": counts.get(b.id, 0),
        }
        for b, tp in rows
    ]

    # Device events, all three layers, in ONE vocabulary:
    #   - iOS Shortcuts pings (already tz-aware in value_json.at), clustered
    #   - browser hosts and macOS apps, reduced to `opened X` by the shared
    #     5-minute gap rule (device_activity.OPEN_GAP)
    # The two interval sensors emit the same `{type:'event', label, kind, at,
    # count}` card the Shortcuts pings do — the timeline renders one row shape
    # and never has to know which sensor a row came from. Their window is the
    # thought window's tail, bounded by DEVICE_STREAM_DAYS (see there for why
    # the derived source can't take the full range).
    from . import device_activity, event_service  # local imports — module-load cycle

    device_start = max(start_utc, end_utc - timedelta(days=DEVICE_STREAM_DAYS))

    items.extend(event_service.list_recent_events(db, start=start_date, end=end_date))
    items.extend(
        {
            "type": "event",
            # `label` carries the sentence WITHOUT the count — the timeline
            # renders `×count` itself, so leaving it in `text` would print it
            # twice ("opened reddit ×8 ×8").
            "label": f"opened {open_row['label']}",
            "kind": open_row["layer"],
            "at": _iso(open_row["at"]),
            "count": open_row["count"],
        }
        for open_row in device_activity.device_opens(db, start=device_start, end=end_utc)
    )

    items.sort(key=lambda it: _sort_key(it.get("at")), reverse=True)
    return {
        "items": items,
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "generated_at": _iso(now),
    }


def _sort_key(iso: str | None) -> float:
    """Epoch seconds for the merge-sort; unparseable → 0 (sinks to the bottom)."""
    if not iso:
        return 0.0
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


# ── Short-term / longer-term split ───────────────────────────────────────────
# The dashboard's spine (whiteboard, 2026-07-28): "short-term things, promises
# that are more to-do based ± can do them soon and 'focus' on them" on the left;
# the slower commitments in their own card on the right. The split is DERIVED
# from due distance — no flag to set, no second way to be wrong.

SHORT_TERM_DAYS = 7  # due within this many days = short-term


def _due_bucket(due_at: datetime | None, is_default: bool, local_now_dt: datetime) -> str:
    """Place a due date in a display bucket, in LOCAL calendar days.

    `due_at` is stored naive UTC; `local_now_dt` is tz-AWARE (from
    common.local_now). Both sides must be compared in the local zone — an
    EOD-anchored due like 11:59pm PT is stored as 06:59 the NEXT UTC day, so
    differencing raw UTC dates would file every "today" under "tomorrow".

    A stale DEFAULTED due rolls forward to `today` instead of reading overdue:
    Gooni picked that date, so it can't accuse you of missing it. An explicit
    one that's passed is genuinely `overdue`.
    """
    if due_at is None:
        return "long"  # legacy undated rows sit with the slow stuff
    due_local = due_at.replace(tzinfo=timezone.utc).astimezone(local_now_dt.tzinfo)
    days = (due_local.date() - local_now_dt.date()).days
    if days < 0:
        return "today" if is_default else "overdue"
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    if days <= SHORT_TERM_DAYS:
        return "this_week"
    return "long"


# Render order for the short-term panel — most urgent first.
SHORT_BUCKETS = ("overdue", "today", "tomorrow", "this_week")


def _device_rollups(db: Session, local_now_dt: datetime) -> list[dict]:
    """Today's Shortcuts telemetry, AGGREGATED — `instagram open · 12`, not
    twelve rows.

    This is what replaced the arcs canvas on the dashboard. The old surface
    rendered every device ping as its own entry, which is the thing Daniel
    called "all this data" — a log you have to read and total in your head. The
    counts are the analysis, and they're deterministic (a sum over the day's
    sum-agg entries), not an LLM summary.

    Descending by count, so the thing you did most is the thing you see.
    """
    from ..db.models import Trackable
    from . import trackable_service

    today = local_now_dt.date()
    rows = db.query(Trackable).filter(Trackable.source == "shortcuts").all()
    out: list[dict] = []
    for t in rows:
        entries = trackable_service.entries_for(db, t, start=today, end=today)
        count = trackable_service.day_value(entries, t)
        if not count:
            continue
        out.append({"label": t.name, "count": int(count)})
    out.sort(key=lambda r: (-r["count"], r["label"]))
    return out


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
    # Self-heal: a commitment whose dated deadline blew by renders the gap on
    # its own (no manual close needed). Flushed here; the route commits.
    auto_break_overdue(db, now)
    topics = list_topics(db, now)

    # Reminders = the dated-todo section: open rows owed to nobody.
    notch_reminders = [r for r in list_reminders(db) if r["type"] == "reminder"]

    # Promises = the said-vs-done section: still-standing (active) AND recently
    # broken (the loud signal). Kept commitments drop off — a fulfilled one
    # isn't a live concern.
    promise_rows = (
        db.query(Promise)
        .filter(Promise.state.in_(("active", "broken")), Promise.owed_to.isnot(None))
        .all()
    )
    promises = _reminder_dicts(db, promise_rows)
    # Active first, oldest → most at-risk; then broken, most-recent break first
    # (the freshest gap reads at the top of the broken run).
    def _promise_sort(r: dict):
        broken = r["state"] == "broken"
        # active: (0, -age) so oldest-active bubbles up; broken: (1, -lasted)
        return (1 if broken else 0, -r["age_days"] if not broken else -r["lasted_days"])

    promises.sort(key=_promise_sort)
    notch_promises = promises

    # ── The dashboard split (whiteboard 2026-07-28) ──────────────────────────
    # One pass over everything open and bucket by due distance. Broken rows stay
    # out: the short-term panel is a to-do surface, and a broken row isn't
    # actionable.
    local = local_now(db)
    open_rows = _reminder_dicts(db, _open_promises(db).all())
    short_term: dict[str, list[dict]] = {b: [] for b in SHORT_BUCKETS}
    long_term: list[dict] = []
    for row in open_rows:
        due = _parse_iso(row.get("due_at"))
        bucket = _due_bucket(due, row.get("due_is_default", False), local)
        if bucket == "long":
            long_term.append(row)
        else:
            short_term[bucket].append(row)

    # Within a bucket: by due time, earliest first (a naive-UTC sort is fine —
    # ordering is monotonic regardless of zone).
    for rows in short_term.values():
        rows.sort(key=lambda r: r.get("due_at") or "")
    long_term.sort(key=lambda r: r.get("due_at") or "")

    log_rows = (
        _tagged(db.query(Note, Topic), BATCH_TAG)
        .join(Topic, Note.topic_id == Topic.id)
        .order_by(Note.updated_at.desc())
        .limit(12)
        .all()
    )
    log = [
        {
            "batch_id": b.id,
            "label": b.title,
            "topic": tp.name,
            "color": tp.color,
            "ended_at": _iso(b.updated_at),
        }
        for b, tp in log_rows
    ]

    return {
        "circles": topics[:DASHBOARD_SLOTS],
        "overflow_topics": topics[DASHBOARD_SLOTS:],  # for displacement notices
        "notch": {"reminders": notch_reminders, "promises": notch_promises},
        "log": log,
        # ── the ambient dashboard reads these three ──────────────────────────
        # `notch` / `circles` / `log` stay for the kiosk's older consumers; the
        # rebuilt dash ignores them.
        "short_term": short_term,  # {overdue|today|tomorrow|this_week: [row]}
        "long_term": long_term,
        "rollups": _device_rollups(db, local),
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


def _parse_iso(s: str | None) -> datetime | None:
    """Inverse of `_iso` — back to the naive-UTC storage convention. Used by the
    dashboard split, which buckets the already-serialized dicts rather than
    re-querying the rows."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _iso(dt: datetime | None) -> str | None:
    """Serialize as UTC-aware ISO-8601. Stored datetimes are naive-UTC (Column
    defaults are datetime.utcnow); stamp +00:00 so the client parses them as UTC
    and converts to LOCAL. Without the offset a naive ISO string is read as
    local time and every timestamp lands hours off (the display-tz bug).
    Already-aware datetimes normalize to UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# SQLite is case-sensitive on = by default; lower() both sides for name lookups.
from sqlalchemy import func as _sa_func  # noqa: E402


def func_lower(col):
    return _sa_func.lower(col)
