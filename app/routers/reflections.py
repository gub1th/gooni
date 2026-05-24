
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Reflection,
)

from ..serializers import (
    _serialize_reflection
)


router = APIRouter()


@router.get("/reflections")
def list_reflections(
    conversation_id: int | None = None,
    message_id: int | None = None,
    severity_min: int = 1,
    kind: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List reflections, filterable by conversation, message, min severity, or
    kind ('turn'|'conv_rollup'). Default returns most-recent 50 across DB."""
    q = db.query(Reflection)
    if conversation_id is not None:
        q = q.filter(Reflection.conversation_id == conversation_id)
    if message_id is not None:
        q = q.filter(Reflection.message_id == message_id)
    if kind:
        q = q.filter(Reflection.kind == kind)
    q = q.filter(Reflection.severity >= severity_min)
    rows = q.order_by(Reflection.id.desc()).limit(min(max(limit, 1), 500)).all()
    return {"reflections": [_serialize_reflection(r) for r in rows]}


@router.post("/reflections/rollup-now")
def trigger_conv_rollup(
    conversation_id: int,
    db: Session = Depends(get_db),
):
    """Manual trigger for the conv-level reflection rollup. Pulls the last 20
    turn reflections in the conv, LLM-summarizes the dominant recurring
    failure modes into one paragraph, persists as a Reflection w/
    kind='conv_rollup'. Master prompt then injects the latest rollup
    instead of dumping raw turns.

    Returns the new rollup row, or null if there weren't enough sev≥2
    turn reflections to summarize.
    """
    from ..services.reflexion_service import reflexion_service
    row = reflexion_service.rollup_conversation(db, conversation_id)
    return {"rollup": _serialize_reflection(row) if row else None}
