
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.get("/focuses")
def focuses_list(db: Session = Depends(get_db)):
    """Active focuses with color + linked-todo progress for the dashboard
    focus cards. Returns the same shape as item_service.list_tree['focuses']
    but as a flat list."""
    from ..services.focus_service import focus_service
    from ..services.item_service import _focus_tree_node
    return [_focus_tree_node(db, f) for f in focus_service.list_active(db)]


@router.post("/focuses/{focus_id}/rename")
def focus_rename(
    focus_id: int, body: dict, db: Session = Depends(get_db),
):
    """User-driven rename for a drifted focus. Snaps initial_signature
    to current_signature so future drift re-bases from the new origin;
    clears drift_flagged_at. Body: {text?, endgoal?}.
    """
    from ..services.focus_service import rename, serialize_focus
    f = rename(
        db, focus_id,
        text=body.get("text"),
        endgoal=body.get("endgoal"),
    )
    if not f:
        raise HTTPException(404, "focus not found")
    return serialize_focus(f, db=db)


@router.post("/focuses/{focus_id}/fork")
def focus_fork(
    focus_id: int, body: dict, db: Session = Depends(get_db),
):
    """Fork a drifted focus into a new lineage. Old focus is preserved
    with status='evolved'; new Focus inherits current_signature as its
    origin and links back via evolved_from_focus_id. Body:
    {new_text, new_endgoal?}.
    """
    from ..services.focus_service import fork, serialize_focus
    new_text = (body.get("new_text") or "").strip()
    if not new_text:
        raise HTTPException(400, "new_text required")
    result = fork(
        db, focus_id,
        new_text=new_text,
        new_endgoal=body.get("new_endgoal"),
    )
    if not result:
        raise HTTPException(404, "focus not found")
    old, new = result
    return {
        "old_focus": serialize_focus(old, db=db),
        "new_focus": serialize_focus(new, db=db),
    }


@router.get("/focuses/{focus_id}")
def focus_get(focus_id: int, db: Session = Depends(get_db)):
    """Single-focus detail — includes the parsed bound-state evidence
    array (snippets of notes/todos/facts/messages currently bound to
    this focus). Heavier than the /focuses list endpoint; used by the
    dashboard drill-down modal.
    """
    from ..services.focus_service import serialize_focus
    from ..db.models import Focus
    import json as _json
    f = db.query(Focus).filter(Focus.id == focus_id).first()
    if not f:
        raise HTTPException(404, "focus not found")
    payload = serialize_focus(f, db=db)
    evidence: list = []
    if f.current_evidence_json:
        try:
            parsed = _json.loads(f.current_evidence_json)
            if isinstance(parsed, list):
                evidence = parsed
        except Exception:
            pass
    payload["evidence"] = evidence
    return payload


@router.post("/focuses/{focus_id}/reactivate")
def focus_reactivate(focus_id: int, db: Session = Depends(get_db)):
    """Bring a dormant focus back into the active pool. Clears
    missed_run_count + drift flag, sets status='committed'. Idempotent
    on already-active focuses (just resets the counters)."""
    from ..services.focus_service import serialize_focus
    from ..db.models import Focus
    f = db.query(Focus).filter(Focus.id == focus_id).first()
    if not f:
        raise HTTPException(404, "focus not found")
    f.status = "committed"
    f.committed = True
    f.missed_run_count = 0
    f.drift_flagged_at = None
    db.commit()
    db.refresh(f)
    return serialize_focus(f, db=db)
