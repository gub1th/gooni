
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.get("/tool-calls/failures")
def tool_call_failures(
    days: int = 7,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    """Recent failed tool calls — surfaces hallucination + integration
    breakage signal on the Build / Ops dashboard."""
    from datetime import datetime, timedelta
    from ..db.models import ToolCall
    cutoff = datetime.utcnow() - timedelta(days=int(days))
    rows = (
        db.query(ToolCall)
        .filter(ToolCall.status == "failed")
        .filter(ToolCall.started_at >= cutoff)
        .order_by(ToolCall.started_at.desc())
        .limit(int(limit))
        .all()
    )
    return [
        {
            "id": r.id,
            "tool_name": r.tool_name,
            "error": r.error or "",
            "conversation_id": r.conversation_id,
            "message_id": r.message_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
        }
        for r in rows
    ]
