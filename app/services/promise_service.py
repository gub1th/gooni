"""Promise CRUD + lifecycle over the `promises` table.

Ambient-loop v2: Promise = THE actionable primitive. One-shot chores
(cadence=once), recurring habits (daily / n_per_week), standing rules
(permanent_do / permanent_never) — all one table. Captures verbatim,
infers deadlines, follows up conversationally, tracks slip patterns.

Lifecycle: active → kept | broken. State transitions fire from chat
("did it" → kept via find_active_match), dashboard PATCH, OR
time-anchored auto-broken (when inferred_due passes unconfirmed).

Cross-entity links live in `edges` (see edge_service). At create
time we wire an `utters` edge from the source Message. (The old
`supports` Promise→Focus edge died with Focus in the Slice 6 nuke —
nesting now uses parent_promise_id.)
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Promise
from . import edge_service
from .embedding_utils import cosine as _cosine, embed_text


SLIP_THRESHOLD = 0.80      # match against past broken promises
DEDUP_THRESHOLD = 0.85     # match against active pending promises (higher
                           # bar: must be near-paraphrase, not just related)


# Canonical time phrases scanned out of an utterance. Resolution is
# delegated to common.parse_due_hint — ONE deadline parser (regex map +
# dateparser fallback, local-tz EOD anchored). This used to be a second,
# divergent parser with utcnow() anchoring ("tonight" at 6pm PT resolved
# to 4:59pm PT the NEXT day).
_TIME_PHRASES = (
    "tonight", "today", "tmrw", "tomorrow",
    "this weekend", "this week", "next week",
)


def _infer_due_from_text(text: str, db: Session | None = None) -> datetime | None:
    """Scan the utterance for a canonical time phrase and resolve it via
    common.parse_due_hint. Cheap (no LLM); returns None when nothing matches.
    """
    if not text:
        return None
    from ..common import parse_due_hint

    lowered = text.lower()
    for phrase in _TIME_PHRASES:
        if re.search(rf"\b{re.escape(phrase)}\b", lowered):
            return parse_due_hint(phrase, db=db)
    return None


def _embed(text: str) -> list[float] | None:
    """Shared embedder (embedding_utils) so promises + memories share
    one embedding space (lets us cosine-match across types)."""
    return embed_text(text)


VALID_CADENCES = ("once", "daily", "n_per_week", "permanent_do", "permanent_never")


def create(
    db: Session,
    *,
    utterance: str,
    summary: str | None = None,
    source_message_id: int | None = None,
    inferred_due: datetime | None = None,
    cadence: str = "once",
    cadence_target: int | None = None,
    is_important: bool = False,
    parent_promise_id: int | None = None,
) -> Promise:
    """Insert a new ACTIVE promise (ambient-loop v2 shape).
    Wires `utters` edge from source Message, sets slip_count from
    cosine match against past broken promises.

    Active dedup: if the utterance cosine-matches an existing ACTIVE
    promise above DEDUP_THRESHOLD, returns the existing row instead of
    inserting a duplicate (touches the `utters` edge for re-statement
    provenance).

    Vague flag: `needs_clarification` = once-cadence with no resolvable
    deadline (structural — no text classifier). Doesn't gate the
    lifecycle — promise is `active` either way. The flag drives ack
    pushback (Gooni asks one sharp clarifier in the same turn) and
    seeds future weekly-digest stats.

    Cadence replaces the old Habit auto-spawn: a recurring commitment IS
    the Promise now (cadence=daily / n_per_week / permanent_*) — no
    shadow Habit row.
    """
    cleaned = utterance.strip()
    if not cleaned:
        raise ValueError("utterance required")

    if cadence not in VALID_CADENCES:
        cadence = "once"
    if cadence != "n_per_week":
        cadence_target = None

    # Recurring commitments carry no single deadline (see normalizer note:
    # a due on a daily/weekly promise is a parse artifact).
    if cadence == "once":
        inferred = inferred_due or _infer_due_from_text(cleaned, db=db)
    else:
        inferred = None

    # Vague-promise flag — STRUCTURAL, no regex (the old promise_complexity
    # module re-detected recurrence shape from raw text; the extractor now
    # emits `cadence` directly, so the only genuinely vague shape left is a
    # one-shot commitment with no resolvable deadline: "imma get better at
    # cooking". Recurring cadences answer "how often counts?" by
    # construction; a due answers "when?"). Metadata only — the promise
    # lands `active` either way; the flag drives the clarifier ack + the
    # overlay's vague list.
    needs_clarification = cadence == "once" and inferred is None
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
        cadence=cadence,
        cadence_target=cadence_target,
        is_important=bool(is_important),
        parent_promise_id=parent_promise_id,
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



def create_from_signal(
    db: Session, sp: dict, source_message_id: int | None = None
) -> Promise | None:
    """Create a Promise from one normalized extractor `promises` create
    signal (the shape stored in Message.signal_preview). Shared by the
    log-view promote route and any auto-create path: resolves the due
    (absolute due_date wins, local-EOD anchored; due_hint phrase falls
    back to common.parse_due_hint) and the parent_hint, then runs the
    full create pipeline (dedup, slip_count, edges, evaluator)."""
    from datetime import datetime as _dt, time as _time, timezone as _tz

    from ..common import local_now, parse_due_hint

    utterance = (sp.get("utterance") or "").strip()
    if not utterance:
        return None

    inferred = None
    due_date = sp.get("due_date")
    if due_date:
        try:
            d = _dt.strptime(due_date, "%Y-%m-%d").date()
            try:
                tzinfo = local_now(db).tzinfo
                local_eod = _dt.combine(d, _time(23, 59), tzinfo=tzinfo)
                inferred = local_eod.astimezone(_tz.utc).replace(tzinfo=None)
            except Exception:
                inferred = _dt.combine(d, _time(23, 59))
        except ValueError:
            inferred = None
    if inferred is None:
        try:
            inferred = parse_due_hint(sp.get("due_hint"), db=db)
        except Exception:
            inferred = None

    parent_id = None
    parent_hint = (sp.get("parent_hint") or "").strip()
    if parent_hint:
        try:
            parent_id = resolve_parent_hint(db, parent_hint)
        except Exception as e:
            print(f"[promise create_from_signal] parent resolve error: {e}")

    return create(
        db,
        utterance=utterance,
        summary=sp.get("summary"),
        source_message_id=source_message_id,
        inferred_due=inferred,
        cadence=sp.get("cadence") or "once",
        cadence_target=sp.get("cadence_target"),
        is_important=bool(sp.get("is_important")),
        parent_promise_id=parent_id,
    )


def delete(db: Session, promise_id: int) -> bool:
    """Hard-delete a promise + its edges. Backs the promote-undo flow
    (a just-promoted Promise vanishes without leaving a broken tombstone)
    and DELETE /promises/{id}."""
    from ..db.models import Edge

    p = get(db, promise_id)
    if p is None:
        return False
    db.query(Edge).filter(
        ((Edge.src_kind == "promise") & (Edge.src_id == promise_id))
        | ((Edge.dst_kind == "promise") & (Edge.dst_id == promise_id))
    ).delete(synchronize_session=False)
    db.delete(p)
    db.commit()
    return True


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
    is_important: bool | None = None,
    cadence: str | None = None,
    cadence_target: Any = _UNSET,
) -> Promise | None:
    """Edit a promise's display text, deadline, importance, or cadence.

    `text` rewrites `summary` (the display field the dashboard shows);
    the raw `utterance` is left untouched as the original-capture record
    for provenance. `inferred_due` is tri-state: omit to leave unchanged,
    pass a `datetime` to set, pass `None` to clear. Same for
    `cadence_target`. Returns the row or None if the promise doesn't exist.
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
    if is_important is not None:
        p.is_important = bool(is_important)
    if cadence is not None and cadence in VALID_CADENCES:
        p.cadence = cadence
        if cadence != "n_per_week":
            p.cadence_target = None
    if cadence_target is not _UNSET:
        p.cadence_target = cadence_target
    db.commit()
    db.refresh(p)
    return p


# ── Chat-side promise matching (complete / break via utterance) ────────

MATCH_THRESHOLD = 0.60   # floor for "did the gym thing" → active promise
AMBIGUITY_GAP = 0.05     # top-2 within this gap → refuse, ask Daniel


def find_active_match(
    db: Session, text: str
) -> tuple[Promise | None, list[dict]]:
    """Resolve a complete/break `match` phrase against ACTIVE promises.

    Returns (promise, ambiguous_candidates):
      - (row, [])      — confident single match, act on it
      - (None, [a, b]) — two candidates within AMBIGUITY_GAP; caller
                         surfaces a "which one?" ack instead of acting
      - (None, [])     — nothing above MATCH_THRESHOLD

    Three deterministic-first tiers:
      1. full-phrase substring ("call paip" in "call paip about rent")
      2. unique content-word overlap ("the gym thing" → the only active
         promise containing "gym") — catches terse referents cosine
         under-scores
      3. cosine ≥ MATCH_THRESHOLD for true paraphrases
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return None, []

    rows = (
        db.query(Promise.id, Promise.summary, Promise.utterance, Promise.embedding)
        .filter(Promise.state == "active")
        .all()
    )
    if not rows:
        return None, []

    lowered = cleaned.lower()
    sub_hits = [
        r for r in rows
        if lowered in (r.summary or "").lower()
        or lowered in (r.utterance or "").lower()
    ]
    if len(sub_hits) == 1:
        return get(db, sub_hits[0].id), []

    # Tier 2: content-word overlap, unique-hit only. Filler words
    # ("thing", "stuff", "one") carry no referent signal — strip them.
    _FILLER = {
        "the", "a", "an", "my", "that", "this", "thing", "things",
        "stuff", "one", "promise", "todo", "and", "for", "with", "about",
    }
    words = [
        w for w in re.findall(r"[a-z0-9']+", lowered)
        if len(w) >= 3 and w not in _FILLER
    ]
    if words:
        word_hits = []
        for r in rows:
            haystack = f"{(r.summary or '').lower()} {(r.utterance or '').lower()}"
            if any(w in haystack for w in words):
                word_hits.append(r)
        if len(word_hits) == 1:
            return get(db, word_hits[0].id), []

    vec = _embed(cleaned)
    if vec is None:
        return None, []
    scored: list[tuple[float, Any]] = []
    for r in rows:
        if not r.embedding:
            continue
        try:
            emb = json.loads(r.embedding)
        except (TypeError, ValueError):
            continue
        s = _cosine(vec, emb)
        if s >= MATCH_THRESHOLD:
            scored.append((s, r))
    if not scored:
        return None, []
    scored.sort(key=lambda t: t[0], reverse=True)
    if len(scored) >= 2 and (scored[0][0] - scored[1][0]) < AMBIGUITY_GAP:
        cands = [
            {"id": r.id, "text": r.summary or r.utterance, "score": round(s, 3)}
            for s, r in scored[:2]
        ]
        return None, cands
    return get(db, scored[0][1].id), []


def resolve_parent_hint(db: Session, hint: str) -> int | None:
    """Resolve a `parent_hint` phrase to an active Promise id — substring
    first, cosine fallback. None when nothing lands."""
    p, ambiguous = find_active_match(db, hint)
    if p is not None:
        return p.id
    if ambiguous:
        # Ambiguity on a parent link is low-stakes — take the top hit.
        return ambiguous[0]["id"]
    return None


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
        # Recurring promises never auto-break on a date — a deadline on a
        # daily/weekly commitment is a parse artifact, not a term end.
        .filter(Promise.cadence == "once")
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
        "cadence": p.cadence or "once",
        "cadence_target": p.cadence_target,
        "is_important": bool(p.is_important),
        "parent_promise_id": p.parent_promise_id,
        "needs_clarification": bool(p.needs_clarification),
        "voice_of_reason": voice,
        "slip_count": p.slip_count,
        "resolved_at": p.resolved_at.isoformat() if p.resolved_at else None,
        "source_message_id": p.source_message_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
