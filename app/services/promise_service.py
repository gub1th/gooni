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
    """Insert a new pending promise, wire `utters` edge from the source
    Message, and best-effort wire `supports` edge to the closest active
    Focus by cosine similarity. Slip count is set from the cosine match
    against past broken promises so re-uttering an old broken pattern
    surfaces immediately.

    Active-pending dedup: if the utterance cosine-matches an existing
    pending Promise above DEDUP_THRESHOLD, we return the existing row
    instead of inserting a duplicate. Wires an `utters` edge from the
    new source message so the conversation graph still records the
    re-statement. Fixes T4→T5 of segment #209 where Daniel re-uttered
    a near-duplicate and the system silently piled up rows.
    """
    cleaned = utterance.strip()
    if not cleaned:
        raise ValueError("utterance required")

    inferred = inferred_due or _infer_due_from_text(cleaned)
    vec = _embed(cleaned)

    # Active-pending dedup BEFORE insert. Skip when no embedding —
    # cosine match isn't possible.
    if vec is not None:
        existing = _find_pending_duplicate(db, vec)
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
        state="pending",
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

    return p


def _find_pending_duplicate(db: Session, vec: list[float]) -> Promise | None:
    """Return the closest active pending Promise above DEDUP_THRESHOLD,
    or None. Tuple-walk first to avoid hydrating non-matches."""
    rows = (
        db.query(Promise.id, Promise.embedding)
        .filter(Promise.state == "pending", Promise.embedding.is_not(None))
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


def list_pending(db: Session, limit: int = 20) -> list[Promise]:
    return (
        db.query(Promise)
        .filter(Promise.state == "pending")
        .order_by(Promise.inferred_due.asc().nullslast(), Promise.created_at.asc())
        .limit(limit)
        .all()
    )


def list_recent(db: Session, limit: int = 50) -> list[Promise]:
    return (
        db.query(Promise)
        .order_by(Promise.created_at.desc())
        .limit(limit)
        .all()
    )


def transition(db: Session, promise_id: int, new_state: str) -> Promise | None:
    """State transition with timestamp + idempotency. `new_state` must
    be one of: pending | kept | broken | abandoned. Re-applying the
    current state is a no-op (no resolved_at churn)."""
    if new_state not in ("pending", "kept", "broken", "abandoned"):
        raise ValueError(f"invalid state: {new_state}")
    p = get(db, promise_id)
    if p is None:
        return None
    if p.state == new_state:
        return p
    p.state = new_state
    p.resolved_at = (
        datetime.utcnow() if new_state in ("kept", "broken", "abandoned") else None
    )
    db.commit()
    db.refresh(p)
    return p


def auto_mark_overdue(db: Session, now: datetime | None = None) -> int:
    """Sweep: any pending promise whose inferred_due is in the past
    gets flipped to broken. Idempotent. Returns count flipped.

    Run by the daily nudge or a background scheduler — kept here so
    the lifecycle stays in one place.
    """
    now = now or datetime.utcnow()
    pending = (
        db.query(Promise)
        .filter(Promise.state == "pending", Promise.inferred_due.is_not(None))
        .filter(Promise.inferred_due < now)
        .all()
    )
    n = 0
    for p in pending:
        p.state = "broken"
        p.resolved_at = now
        n += 1
    if n:
        db.commit()
    return n


def serialize(p: Promise) -> dict[str, Any]:
    return {
        "id": p.id,
        "utterance": p.utterance,
        "summary": p.summary,
        "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
        "state": p.state,
        "slip_count": p.slip_count,
        "resolved_at": p.resolved_at.isoformat() if p.resolved_at else None,
        "source_message_id": p.source_message_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
