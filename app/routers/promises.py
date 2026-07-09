
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..common import _parse_optional_due

from ..serializers import (
    _serialize_promise
)


router = APIRouter()


@router.get("/promises")
def list_promises(
    state: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List promises. Default returns the most recent N regardless of state
    so the dashboard drawer can show history alongside active commitments.
    Pass `state=active|kept|broken` for one slate.
    """
    from ..db.models import Promise as _Promise

    q = db.query(_Promise)
    # G3.1 lifecycle: active | kept | broken. The proposed/pending lock-in
    # split + `abandoned` terminal were removed from promise_service; this
    # list previously lagged behind that migration and 400'd state=active
    # while returning nothing for the now-dead state=pending.
    _VALID_STATES = ("active", "kept", "broken")
    if state:
        if state not in _VALID_STATES:
            raise HTTPException(
                status_code=400,
                detail=f"invalid state (expected one of {_VALID_STATES})",
            )
        q = q.filter(_Promise.state == state)
    # Active sorts deadline-first so the closest-due promise bubbles up;
    # everything else sorts by recency.
    if state == "active":
        q = q.order_by(
            _Promise.inferred_due.asc().nullslast(), _Promise.created_at.desc()
        )
    else:
        q = q.order_by(_Promise.created_at.desc())
    rows = q.limit(limit).all()
    return [_serialize_promise(p) for p in rows]


@router.post("/promises")
def create_promise(body: dict, db: Session = Depends(get_db)):
    """Manually add a promise from the dashboard drawer. Promises usually
    land via chat utterances; this is the direct-entry path. Runs the same
    `promise_service.create` pipeline (complexity classify, embed, closest-
    focus `supports` edge) minus the source-message `utters` edge.
    Optional v2 fields: cadence, cadence_target, is_important,
    parent_promise_id.
    """
    from ..services import promise_service

    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    cadence = body.get("cadence") or "once"
    if cadence not in promise_service.VALID_CADENCES:
        raise HTTPException(
            status_code=400,
            detail=f"cadence must be one of {promise_service.VALID_CADENCES}",
        )
    p = promise_service.create(
        db,
        utterance=text,
        cadence=cadence,
        cadence_target=body.get("cadence_target"),
        is_important=bool(body.get("is_important")),
        parent_promise_id=body.get("parent_promise_id"),
    )
    return _serialize_promise(p)


@router.get("/promises/pis")
def promise_integrity_score(db: Session = Depends(get_db)):
    """Promise Integrity Score — Daniel's accountability scoreboard.

    G3.1 weighting (3-state lifecycle):
      kept   → +1.0
      broken → -1.5  (asymmetric: breaking stings more than keeping helps)
      active → 0     (not counted; resolution unknown yet)

    Normalized to 0..100 percentage. Plus current kept-streak (consecutive
    `kept` walking back from most recent) and last_broken metadata.

    Returns `{score: null, ...}` when fewer than 3 resolved promises exist
    — small-N noise distorts the score, better to show "not enough data".

    Algorithm notes:
      score% = ((sum + theoretical_min_abs) / theoretical_range) * 100
      Pre-G3.1 `abandoned` rolled into `broken` during the state collapse
      migration; the score function lost its softer-penalty middle ground.
      If a softer 'gave up gracefully' verdict comes back, add a state +
      re-introduce the asymmetric weight here.
    """
    from ..db.models import Promise as _Promise

    RESOLVED = ("kept", "broken")
    WEIGHTS = {"kept": 1.0, "broken": -1.5}
    MIN_SAMPLE = 3
    WINDOW = 20

    rows = (
        db.query(_Promise)
        .filter(_Promise.state.in_(RESOLVED))
        .order_by(_Promise.resolved_at.desc().nullslast(), _Promise.id.desc())
        .limit(WINDOW)
        .all()
    )
    sample_size = len(rows)

    if sample_size < MIN_SAMPLE:
        return {
            "score": None,
            "sample_size": sample_size,
            "min_sample": MIN_SAMPLE,
            "kept_streak": 0,
            "last_broken_at": None,
            "last_broken_summary": None,
            "weights": WEIGHTS,
            "window": WINDOW,
            "note": "need at least 3 resolved promises to compute",
        }

    total = sum(WEIGHTS[r.state] for r in rows)
    # Theoretical range across the sample window.
    theoretical_max = sample_size * 1.0          # all kept
    theoretical_min = sample_size * -1.5         # all broken
    range_ = theoretical_max - theoretical_min   # = sample_size * 2.5
    pct = int(round(((total - theoretical_min) / range_) * 100))
    pct = max(0, min(100, pct))

    # Kept streak — walk recent-first until we hit a non-kept.
    streak = 0
    for r in rows:
        if r.state == "kept":
            streak += 1
        else:
            break

    last_broken = next((r for r in rows if r.state == "broken"), None)

    return {
        "score": pct,
        "sample_size": sample_size,
        "min_sample": MIN_SAMPLE,
        "kept_streak": streak,
        "last_broken_at": (
            last_broken.resolved_at.isoformat() if last_broken and last_broken.resolved_at else None
        ),
        "last_broken_summary": (
            (last_broken.summary or last_broken.utterance)
            if last_broken else None
        ),
        "weights": WEIGHTS,
        "window": WINDOW,
    }


@router.delete("/promises/{promise_id}")
def delete_promise(promise_id: int, db: Session = Depends(get_db)):
    """Hard-delete a promise + its edges. Backs the log-view promote-undo
    and manual cleanup — distinct from `broken` (which is a tracked slip)."""
    from ..services import promise_service

    if not promise_service.delete(db, promise_id):
        raise HTTPException(status_code=404, detail="Promise not found")
    return {"deleted": True, "id": promise_id}


@router.patch("/promises/{promise_id}")
def patch_promise(promise_id: int, body: dict, db: Session = Depends(get_db)):
    """Edit a promise. Independent, optional fields:

      - `state`: active | kept | broken (G3.1 transition — same
        idempotency + resolved_at bookkeeping as `promise_service.transition`).
      - `text`: rewrites the display `summary` (utterance kept for provenance).
      - `due`: ISO datetime, or `""`/`null` to clear the deadline.
      - `is_important`: bool — overlay importance star.
      - `cadence` (+ optional `cadence_target`): recurrence shape.

    Send any subset. Non-state edits are applied first, then the state
    transition, so the returned row reflects all edits in one round-trip.
    """
    from ..services import promise_service

    has_text = "text" in body
    has_due = "due" in body
    has_state = "state" in body
    has_important = "is_important" in body
    has_cadence = "cadence" in body
    has_target = "cadence_target" in body
    if not (has_text or has_due or has_state or has_important or has_cadence or has_target):
        raise HTTPException(status_code=400, detail="nothing to update")

    if has_cadence and body.get("cadence") not in promise_service.VALID_CADENCES:
        raise HTTPException(
            status_code=400,
            detail=f"cadence must be one of {promise_service.VALID_CADENCES}",
        )

    if has_text or has_due or has_important or has_cadence or has_target:
        kwargs: dict = {}
        if has_text:
            kwargs["text"] = body.get("text") or ""
        if has_due:
            kwargs["inferred_due"] = _parse_optional_due(body.get("due"))
        if has_important:
            kwargs["is_important"] = bool(body.get("is_important"))
        if has_cadence:
            kwargs["cadence"] = body.get("cadence")
        if has_target:
            kwargs["cadence_target"] = body.get("cadence_target")
        p = promise_service.update(db, promise_id, **kwargs)
        if p is None:
            raise HTTPException(status_code=404, detail="Promise not found")

    if has_state:
        new_state = body.get("state")
        if new_state not in ("active", "kept", "broken"):
            raise HTTPException(status_code=400, detail="state must be active|kept|broken")
        p = promise_service.transition(db, promise_id, new_state)
        if p is None:
            raise HTTPException(status_code=404, detail="Promise not found")

    return _serialize_promise(p)
