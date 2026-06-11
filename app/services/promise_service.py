"""Promise CRUD + lifecycle over the `promises` table.

Promises = soft commitments uttered in chat ("imma X tonight" /
"i'll Y this week"). Distinct from Todo (chore-shaped) and Focus
(long arc). Gooni's accountability surface: captures verbatim, infers
deadlines, follows up conversationally, tracks slip patterns.

Lifecycle: pending → kept | broken | abandoned. State transitions
fire from user replies to follow-up nudges OR from time-anchored
auto-broken (when inferred_due passes with no confirmed kept).

Cross-entity links live in `edges` (see edge_service). At create
time we wire:
  - utters       Message → Promise   (source message)
  - supports    Promise → Focus      (if cosine-match to active focus
                                       above SUPPORTS_THRESHOLD)
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, Promise
from . import edge_service
from .list_service import _cosine, list_service


SUPPORTS_THRESHOLD = 0.75  # promise → focus auto-link cutoff
SLIP_THRESHOLD = 0.80      # match against past broken promises
DEDUP_THRESHOLD = 0.85     # match against active pending promises (higher
                           # bar: must be near-paraphrase, not just related)


_TIME_HINTS = {
    "tonight": ("today_eod", None),
    "today": ("today_eod", None),
    "tmrw": ("plus_days", 1),
    "tomorrow": ("plus_days", 1),
    "this week": ("plus_days", 7),
    "this weekend": ("next_weekend", None),
    "next week": ("plus_days", 14),
}


def _infer_due_from_text(text: str, anchor: datetime | None = None) -> datetime | None:
    """Cheap regex pass over the utterance to pull a deadline. LLM
    parsing would be more accurate but costs a turn — start cheap, fall
    back to None if no hint matches. Caller can run the LLM path later
    when slip_count > 0 makes accuracy more valuable.
    """
    if not text:
        return None
    now = anchor or datetime.utcnow()
    lowered = text.lower()
    for phrase, (rule, arg) in _TIME_HINTS.items():
        if re.search(rf"\b{re.escape(phrase)}\b", lowered):
            if rule == "today_eod":
                return now.replace(hour=23, minute=59, second=0, microsecond=0)
            if rule == "plus_days" and isinstance(arg, int):
                return (now + timedelta(days=arg)).replace(
                    hour=23, minute=59, second=0, microsecond=0
                )
            if rule == "next_weekend":
                # weekday() Mon=0 ... Sun=6. Saturday=5.
                days_to_sat = (5 - now.weekday()) % 7 or 7
                return (now + timedelta(days=days_to_sat)).replace(
                    hour=23, minute=59, second=0, microsecond=0
                )
    return None


def _embed(text: str) -> list[float] | None:
    """Reuse list_service's embedder so promises + items share the
    same embedding space (lets us cosine-match across types later)."""
    if not text or not text.strip():
        return None
    return list_service._embed_item_text(text.strip())


def create(
    db: Session,
    *,
    utterance: str,
    summary: str | None = None,
    source_message_id: int | None = None,
    inferred_due: datetime | None = None,
) -> Promise:
    """Insert a new ACTIVE promise (G3.1: no more `proposed` / `pending`).
    Wires `utters` edge from source Message, best-effort `supports` edge
    to closest active Focus, sets slip_count from cosine match against
    past broken promises.

    Active dedup: if the utterance cosine-matches an existing ACTIVE
    promise above DEDUP_THRESHOLD, returns the existing row instead of
    inserting a duplicate (touches the `utters` edge for re-statement
    provenance).

    Complexity classifier: runs `promise_complexity.needs_game_plan` and
    stores it as `needs_clarification` metadata. Doesn't gate the
    lifecycle — promise is `active` either way. The flag drives ack
    pushback (Gooni asks one sharp clarifier in the same turn) and
    seeds future weekly-digest stats.

    Habit auto-spawn: runs at CREATE time when the utterance has a
    recurring shape ("no weed for 7 days", "leetcode daily"). Previously
    deferred to the proposed→pending lock-in flip — flip is gone, so
    auto-spawn fires here. Same outcome, no waiting state.
    """
    cleaned = utterance.strip()
    if not cleaned:
        raise ValueError("utterance required")

    # G3.1 complexity classification — pure-regex, no LLM. The bool
    # determines `needs_clarification` metadata, NOT the state. Both
    # vague and concrete utterances land as `active` immediately.
    try:
        from . import promise_complexity
        needs_clarification = promise_complexity.needs_game_plan(cleaned)
    except Exception as e:
        print(f"[promise complexity] classifier error: {e}")
        needs_clarification = False
    print(
        f"[promise complexity] needs_clarification={needs_clarification} "
        f"for: {cleaned[:80]}"
    )

    inferred = inferred_due or _infer_due_from_text(cleaned)
    vec = _embed(cleaned)

    # Active dedup BEFORE insert. Skip when no embedding — cosine match
    # isn't possible.
    if vec is not None:
        existing = _find_active_duplicate(db, vec)
        if existing is not None:
            # Touch source-msg edge on the existing row so we don't lose
            # the re-statement provenance.
            if source_message_id is not None:
                try:
                    edge_service.link(
                        db,
                        src_kind="message",
                        src_id=source_message_id,
                        dst_kind="promise",
                        dst_id=existing.id,
                        kind="utters",
                    )
                except Exception as e:
                    print(f"[promise dedup] edge link failed: {e}")
            return existing

    slip = _count_prior_slips(db, vec) if vec else 0

    p = Promise(
        utterance=cleaned,
        summary=(summary or cleaned)[:200],
        inferred_due=inferred,
        state="active",
        needs_clarification=needs_clarification,
        slip_count=slip,
        source_message_id=source_message_id,
        embedding=json.dumps(vec) if vec else None,
    )
    db.add(p)
    db.commit()
    db.refresh(p)

    if source_message_id is not None:
        edge_service.link(
            db,
            src_kind="message",
            src_id=source_message_id,
            dst_kind="promise",
            dst_id=p.id,
            kind="utters",
        )

    if vec is not None:
        focus_id, score = _closest_focus(db, vec)
        if focus_id is not None and score >= SUPPORTS_THRESHOLD:
            edge_service.link(
                db,
                src_kind="promise",
                src_id=p.id,
                dst_kind="focus",
                dst_id=focus_id,
                kind="supports",
                weight=score,
            )

    # Voice-of-reason evaluation — deterministic checks (coupled reward,
    # conflicts active, too vague, track-record doubt). Returns None when
    # the promise passes all checks. Tagged onto the in-memory Promise as
    # `_voice_of_reason` so the orchestrator's ack helper + just-extracted
    # block can surface it without re-running the checks. Not persisted —
    # rules can evolve; recompute on demand if a callsite needs them.
    try:
        from . import promise_evaluator
        verdict = promise_evaluator.evaluate(
            db,
            utterance=cleaned,
            summary=p.summary,
            slip_count=p.slip_count or 0,
            vec=vec,
            # p is already committed — without this every promise
            # cosine-matches itself at 1.0 and flags conflicts_active.
            exclude_id=p.id,
        )
        if verdict is not None:
            p._voice_of_reason = verdict
            print(
                f"[promise voice-of-reason] flag={verdict['primary']} "
                f"for: {cleaned[:80]}"
            )
    except Exception as e:
        print(f"[promise voice-of-reason] evaluator failed: {e}")

    # G3.1 Habit auto-spawn — fires at CREATE time on recurring-shape
    # promises ("no weed for 7 days", "leetcode daily"). Was deferred to
    # proposed→pending lock-in; lock-in is gone so we spawn now. Same
    # outcome, no waiting state. Errors swallowed — habit creation
    # never blocks the promise insert.
    try:
        _maybe_auto_create_habit(db, p)
    except Exception as e:
        print(f"[promise create] habit auto-create failed: {e}")

    return p


def _find_active_duplicate(db: Session, vec: list[float]) -> Promise | None:
    """Return the closest ACTIVE Promise above DEDUP_THRESHOLD, or None.
    Tuple-walk first to avoid hydrating non-matches.
    """
    rows = (
        db.query(Promise.id, Promise.embedding)
        .filter(Promise.state == "active", Promise.embedding.is_not(None))
        .all()
    )
    best_id: int | None = None
    best_score = 0.0
    for pid, raw in rows:
        try:
            emb = json.loads(raw)
        except (TypeError, ValueError):
            continue
        score = _cosine(vec, emb)
        if score >= DEDUP_THRESHOLD and score > best_score:
            best_id = pid
            best_score = score
    if best_id is None:
        return None
    return db.query(Promise).filter(Promise.id == best_id).first()


def _count_prior_slips(db: Session, vec: list[float]) -> int:
    """Count past broken promises whose embedding cosine-matches the
    new utterance above SLIP_THRESHOLD. Tuple query so we don't hydrate
    full Promise rows."""
    rows = (
        db.query(Promise.id, Promise.embedding)
        .filter(Promise.state == "broken", Promise.embedding.is_not(None))
        .all()
    )
    n = 0
    for _id, raw in rows:
        try:
            emb = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if _cosine(vec, emb) >= SLIP_THRESHOLD:
            n += 1
    return n


def _closest_focus(db: Session, vec: list[float]) -> tuple[int | None, float]:
    """Best-matching active Focus by cosine over its text+endgoal
    embedding. Returns (focus_id, score). Embedding lazy-built here if
    Focus doesn't have one yet — first call pays the cost.
    """
    rows = (
        db.query(Focus.id, Focus.text, Focus.endgoal, Focus.current_signature)
        .filter(Focus.status.in_(("committed", "someday")))
        .all()
    )
    best_id: int | None = None
    best_score = 0.0
    for fid, text, endgoal, sig_raw in rows:
        if sig_raw:
            try:
                emb = json.loads(sig_raw)
            except (TypeError, ValueError):
                emb = None
        else:
            emb = None
        if not emb:
            # Lazy embed of text+endgoal — cheap and cached by upstream
            # focus logic; here we just compute one-shot for matching.
            emb = _embed(f"{text or ''}\n{endgoal or ''}")
        if not emb:
            continue
        score = _cosine(vec, emb)
        if score > best_score:
            best_score = score
            best_id = fid
    return best_id, best_score


def get(db: Session, promise_id: int) -> Promise | None:
    return db.query(Promise).filter(Promise.id == promise_id).first()


def list_active(db: Session, limit: int = 20) -> list[Promise]:
    """List active (un-resolved) promises, due-soonest first. G3.1
    renamed from `list_pending` — same semantic, new state name.
    """
    return (
        db.query(Promise)
        .filter(Promise.state == "active")
        .order_by(Promise.inferred_due.asc().nullslast(), Promise.created_at.asc())
        .limit(limit)
        .all()
    )


# Back-compat shim: external callers may still import `list_pending`.
# Aliasing instead of leaving a dead function — single source of truth.
list_pending = list_active


def list_recent(db: Session, limit: int = 50) -> list[Promise]:
    return (
        db.query(Promise)
        .order_by(Promise.created_at.desc())
        .limit(limit)
        .all()
    )


def transition(db: Session, promise_id: int, new_state: str) -> Promise | None:
    """G3.1 state transition. `new_state` must be one of:
    `active` | `kept` | `broken`. Re-applying current state is a no-op
    (no resolved_at churn).

    Lock-in is gone — promises land active on create, habit auto-spawn
    now fires at create-time when recurring-shaped. This function only
    handles terminal transitions (→ kept, → broken) and explicit revival
    (kept/broken → active, which clears resolved_at).
    """
    if new_state not in ("active", "kept", "broken"):
        raise ValueError(f"invalid state: {new_state} (expected active|kept|broken)")
    p = get(db, promise_id)
    if p is None:
        return None
    if p.state == new_state:
        return p
    p.state = new_state
    p.resolved_at = (
        datetime.utcnow() if new_state in ("kept", "broken") else None
    )
    db.commit()
    db.refresh(p)
    return p


# Sentinel so `update` can tell "field omitted" apart from "explicitly
# set to None" (clearing a deadline).
_UNSET: Any = object()


def update(
    db: Session,
    promise_id: int,
    *,
    text: str | None = None,
    inferred_due: Any = _UNSET,
) -> Promise | None:
    """Edit a promise's display text and/or deadline.

    `text` rewrites `summary` (the display field the dashboard shows);
    the raw `utterance` is left untouched as the original-capture record
    for provenance. `inferred_due` is tri-state: omit to leave unchanged,
    pass a `datetime` to set, pass `None` to clear. Returns the row or
    None if the promise doesn't exist.
    """
    p = get(db, promise_id)
    if p is None:
        return None
    if text is not None:
        cleaned = text.strip()
        if cleaned:
            p.summary = cleaned
    if inferred_due is not _UNSET:
        p.inferred_due = inferred_due
    db.commit()
    db.refresh(p)
    return p


# ── Habit auto-spawn (G3.1: fires at Promise create, not lock-in) ──────
# When a new promise's utterance describes a recurring action
# (daily/weekly/for-N-days/every-X), we spawn a Habit row so Daniel gets
# the daily scoreboard alongside the term contract. Previously deferred
# to proposed→pending lock-in; lock-in is gone so this runs at create.
# The Habit name is derived from the utterance, polarity from a small
# negation-prefix regex. Cosine dedup against existing habits prevents
# a re-uttered promise from spawning a duplicate.

_NEGATION_RE = __import__("re").compile(
    r"^\s*(no|don'?t|stop|avoid|quit|cut|skip|kill)\s+", __import__("re").IGNORECASE,
)


def _derive_habit(utterance: str, summary: str | None) -> tuple[str, str]:
    """Return (name, polarity) for an auto-created Habit derived from a
    locked-in Promise. Polarity is `negative` (avoidance) when the
    utterance starts with a negation verb, else `positive` (do this).
    Name is the summary if present, else the utterance — capped at 60
    chars to fit the Habit display.
    """
    raw = (summary or utterance or "").strip()
    polarity = "negative" if _NEGATION_RE.match(raw) else "positive"
    # For positive habits we keep the leading verb; for negative we keep
    # the "no X" form so the daily scoreboard renders unambiguously
    # ("no weed" toggled True/False per day reads cleanly).
    name = raw[:60].rstrip()
    return name, polarity


def _maybe_auto_create_habit(db: Session, p: Promise) -> None:
    """Spawn a Habit + measured_by edge for a recurring-shape promise.
    Skipped when (a) the utterance isn't recurring-shaped, (b) a
    near-name Habit already exists, or (c) the habit_service call
    blows up — never breaks the promise create path.
    """
    from . import promise_complexity, habit_service

    text = p.utterance or p.summary or ""
    if not promise_complexity.is_recurring(text):
        return  # not recurring — Promise alone is the right shape

    name, polarity = _derive_habit(p.utterance, p.summary)
    if not name:
        return

    # Cheap dedup: exact-name match (case-insensitive) wins. Fuzzy match
    # is intentionally not used — for habit creation we want to be
    # conservative; if the user has "no weed" already, lock-in just
    # links to it rather than risking a misfire on a near-name.
    existing = habit_service.find_by_name(db, name)
    if existing is not None:
        habit = existing
    else:
        habit = habit_service.create(db, name=name, polarity=polarity)

    try:
        edge_service.link(
            db,
            src_kind="promise",
            src_id=p.id,
            dst_kind="habit",
            dst_id=habit.id,
            kind="measured_by",
        )
    except Exception as e:
        print(f"[promise lock-in] measured_by edge link failed: {e}")


def auto_mark_overdue(db: Session, now: datetime | None = None) -> int:
    """Sweep: any active promise whose inferred_due is in the past gets
    flipped to broken. Idempotent. Returns count flipped.

    Run by the daily nudge or a background scheduler — kept here so the
    lifecycle stays in one place. G3.1: filters on `active` (was
    `pending` pre-collapse).
    """
    now = now or datetime.utcnow()
    overdue = (
        db.query(Promise)
        .filter(Promise.state == "active", Promise.inferred_due.is_not(None))
        .filter(Promise.inferred_due < now)
        .all()
    )
    n = 0
    for p in overdue:
        p.state = "broken"
        p.resolved_at = now
        n += 1
    if n:
        db.commit()
    return n


def serialize(p: Promise) -> dict[str, Any]:
    # voice_of_reason is only present on freshly-created Promise rows
    # (set by promise_service.create after the evaluator runs). Re-fetched
    # rows won't have it; serialize emits null in that case so consumers
    # never KeyError. Re-run the evaluator on demand if a callsite needs
    # the verdict for a historical Promise.
    voice = getattr(p, "_voice_of_reason", None)
    return {
        "id": p.id,
        "utterance": p.utterance,
        "summary": p.summary,
        "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
        "state": p.state,
        "needs_clarification": bool(p.needs_clarification),
        "voice_of_reason": voice,
        "slip_count": p.slip_count,
        "resolved_at": p.resolved_at.isoformat() if p.resolved_at else None,
        "source_message_id": p.source_message_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
