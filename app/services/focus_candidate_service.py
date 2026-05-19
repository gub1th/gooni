"""Focus candidate persistence + lifecycle.

The synthesizer surfaces focus-shaped clusters as candidates; this
service is what makes them durable. Top-level and sub-cluster focus
candidates persist with a deterministic cluster_signature so repeat
synth runs upsert the same row (bump seen_count) instead of spawning
duplicates. State / noise clusters are intentionally not persisted —
state lives as bound evidence under its parent focus, noise lives only
in the synth output.

Lifecycle: 'proposed' → 'promoted' (creates a real Focus row) OR
'dismissed' (stays in DB so the synthesizer doesn't re-surface the same
cluster forever). seen_count gives us signal-strength data for ranking
across runs.
"""

import hashlib
import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, FocusCandidate
from .focus_service import focus_service


def _compute_cluster_signature(evidence: list[dict]) -> str:
    """sha256 of sorted '{kind}#{id}' pairs. Deterministic per cluster
    shape — re-emit yields the same hash, item-shift yields a fresh
    hash. Sorted so order-instability in the cluster doesn't cause
    spurious new rows.
    """
    items = sorted(f"{e['kind']}#{e['id']}" for e in evidence)
    return hashlib.sha256("|".join(items).encode()).hexdigest()


def _upsert_one(
    db: Session,
    payload: dict,
    parent_id: int | None,
    now: datetime,
) -> int | None:
    """Upsert a single focus-shaped cluster. Returns the row id, or None
    if the payload is missing required fields (no evidence / no name).
    """
    evidence = payload.get("evidence") or []
    if not evidence:
        return None
    cls = payload.get("classification") or {}
    name = (cls.get("name") or "").strip()
    if not name:
        return None

    sig = _compute_cluster_signature(evidence)
    endgoal = cls.get("endgoal") or None
    confidence = float(cls.get("confidence") or 0.0)
    reasoning = cls.get("reasoning") or None
    centroid = payload.get("centroid_embedding")
    centroid_json = json.dumps(centroid) if centroid else None

    existing = (
        db.query(FocusCandidate)
        .filter(FocusCandidate.cluster_signature == sig)
        .first()
    )

    if existing:
        # Re-sighted. Bump last_seen + seen_count, refresh the
        # classification snapshot (the LLM may have produced a better
        # name/endgoal this run), but DON'T touch status — if user
        # dismissed/promoted previously, that decision sticks.
        existing.last_seen_in_synth = now
        existing.seen_count = (existing.seen_count or 1) + 1
        existing.name = name
        existing.endgoal = endgoal
        existing.confidence = confidence
        existing.reasoning = reasoning
        existing.evidence_json = json.dumps(evidence)
        if centroid_json is not None:
            existing.centroid_embedding = centroid_json
        existing.updated_at = now
        return existing.id

    row = FocusCandidate(
        name=name,
        endgoal=endgoal,
        category="focus",
        confidence=confidence,
        reasoning=reasoning,
        cluster_signature=sig,
        evidence_json=json.dumps(evidence),
        centroid_embedding=centroid_json,
        parent_candidate_id=parent_id,
        status="proposed",
        first_seen_in_synth=now,
        last_seen_in_synth=now,
        seen_count=1,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()  # need the id for child sub-cluster persistence
    return row.id


def persist_run(db: Session, synth_output: dict) -> list[dict]:
    """Persist focus-shaped candidates from a synth output payload.

    Iterates top-level candidates + their focus-shaped children.
    Top-level focus parents land first so children can FK to a real
    parent id. Returns serialized snapshots of every persisted row
    (new or updated) from this run.
    """
    now = datetime.utcnow()
    persisted_ids: list[int] = []

    for cand in synth_output.get("candidates", []):
        cls = cand.get("classification") or {}
        if cls.get("category") != "focus":
            continue
        parent_id = _upsert_one(db, cand, parent_id=None, now=now)
        if parent_id is None:
            continue
        persisted_ids.append(parent_id)
        for child in cand.get("children") or []:
            ccls = child.get("classification") or {}
            if ccls.get("category") != "focus":
                continue
            child_id = _upsert_one(db, child, parent_id=parent_id, now=now)
            if child_id is not None:
                persisted_ids.append(child_id)

    db.commit()
    if not persisted_ids:
        return []

    rows = (
        db.query(FocusCandidate)
        .filter(FocusCandidate.id.in_(persisted_ids))
        .all()
    )
    return [serialize_candidate(r) for r in rows]


def get(db: Session, candidate_id: int) -> FocusCandidate | None:
    return (
        db.query(FocusCandidate)
        .filter(FocusCandidate.id == candidate_id)
        .first()
    )


def list_candidates(
    db: Session, status: str | None = "proposed"
) -> list[FocusCandidate]:
    """Order by confidence desc then seen_count desc. Highest-confidence
    cluster surfaces first; ties break toward the cluster that's been
    re-sighted most across runs (stronger signal)."""
    q = db.query(FocusCandidate)
    if status:
        q = q.filter(FocusCandidate.status == status)
    return q.order_by(
        FocusCandidate.confidence.desc(),
        FocusCandidate.seen_count.desc(),
        FocusCandidate.id.desc(),
    ).all()


def promote(
    db: Session, candidate_id: int
) -> tuple[FocusCandidate, Focus] | None:
    """Create a Focus row from this candidate. Idempotent on a candidate
    that's already promoted — returns the existing pair.
    """
    cand = get(db, candidate_id)
    if not cand:
        return None
    if cand.status == "promoted" and cand.promoted_focus_id:
        focus = (
            db.query(Focus)
            .filter(Focus.id == cand.promoted_focus_id)
            .first()
        )
        if focus:
            return cand, focus
    if cand.status != "proposed":
        return None

    focus = focus_service.create(
        db,
        text=cand.name,
        endgoal=cand.endgoal,
        committed=True,
        status="committed",
    )

    # Stamp the drift / lineage cols. initial_signature is frozen at
    # promotion — never moves. current_signature starts identical, then
    # drifts as the binding pass re-binds clusters on future runs.
    # current_evidence_json is the snapshot of what backed the focus
    # at birth; it's refreshed every successful bind.
    centroid_json = cand.centroid_embedding  # already JSON-encoded
    focus.initial_signature = centroid_json
    focus.current_signature = centroid_json
    focus.current_evidence_json = cand.evidence_json
    focus.last_seen_in_synth = datetime.utcnow()
    focus.missed_run_count = 0
    focus.promoted_from_candidate_id = cand.id

    cand.status = "promoted"
    cand.promoted_focus_id = focus.id
    cand.promoted_at = datetime.utcnow()
    db.commit()
    db.refresh(cand)
    db.refresh(focus)

    # Graduate source notes — for every note in the candidate's evidence,
    # flip Note.status='graduated' + write a `derives_from` edge from
    # the note to the new focus. Closes the loop: unprocessed notes
    # surfaced as a cluster → cluster promoted → those notes leave the
    # triage queue + carry an audit trail back to the focus they spawned.
    # Wrapped in try/except per-note so one bad edge doesn't break the
    # whole promotion path.
    try:
        _graduate_evidence_notes(db, cand, focus)
    except Exception as e:
        print(f"[focus_candidate.promote] note graduation failed: {e}")

    return cand, focus


def _graduate_evidence_notes(
    db: Session, cand: FocusCandidate, focus: Focus
) -> None:
    """Walk the candidate's evidence_json, find every Note entry, and:
      1. Flip Note.status='graduated' (skipping notes already graduated
         or archived — never un-archive)
      2. Write `derives_from` edge: src=note, dst=focus, kind=derives_from
    Idempotent on the edges (edge_service.link uses 5-tuple uniq).
    """
    from . import edge_service
    from ..db.models import Note as NoteModel

    raw = cand.evidence_json or "[]"
    try:
        evidence = json.loads(raw)
    except Exception:
        return
    note_ids: list[int] = []
    for e in evidence:
        if isinstance(e, dict) and e.get("kind") == "note":
            nid = e.get("id")
            if isinstance(nid, int):
                note_ids.append(nid)
    if not note_ids:
        return
    rows = db.query(NoteModel).filter(NoteModel.id.in_(note_ids)).all()
    changed = 0
    for note in rows:
        try:
            edge_service.link(
                db,
                src_kind="note",
                src_id=note.id,
                dst_kind="focus",
                dst_id=focus.id,
                kind="derives_from",
            )
        except Exception as e:
            print(f"[graduate] edge link failed for note {note.id}: {e}")
        # Don't un-archive; only flip the unprocessed → graduated edge.
        if note.status == "unprocessed":
            note.status = "graduated"
            changed += 1
    if changed:
        db.commit()


def dismiss(db: Session, candidate_id: int) -> FocusCandidate | None:
    """Mark dismissed. Stays in DB so the synthesizer's upsert path
    keeps respecting the decision on re-emit (status untouched on
    re-sighting).
    """
    cand = get(db, candidate_id)
    if not cand or cand.status != "proposed":
        return None
    cand.status = "dismissed"
    cand.dismissed_at = datetime.utcnow()
    db.commit()
    db.refresh(cand)
    return cand


def serialize_candidate(c: FocusCandidate) -> dict[str, Any]:
    return {
        "id": c.id,
        "name": c.name,
        "endgoal": c.endgoal,
        "category": c.category,
        "confidence": c.confidence,
        "reasoning": c.reasoning,
        "cluster_signature": c.cluster_signature,
        "evidence": json.loads(c.evidence_json or "[]"),
        "parent_candidate_id": c.parent_candidate_id,
        "status": c.status,
        "promoted_focus_id": c.promoted_focus_id,
        "promoted_at": c.promoted_at.isoformat() if c.promoted_at else None,
        "dismissed_at": c.dismissed_at.isoformat() if c.dismissed_at else None,
        "first_seen_in_synth": (
            c.first_seen_in_synth.isoformat()
            if c.first_seen_in_synth else None
        ),
        "last_seen_in_synth": (
            c.last_seen_in_synth.isoformat()
            if c.last_seen_in_synth else None
        ),
        "seen_count": c.seen_count,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }
