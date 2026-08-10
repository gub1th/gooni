
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.post("/tool-calls/mcp")
def log_mcp_tool_call(body: dict, db: Session = Depends(get_db)):
    """Record one MCP tool invocation.

    Exists because the stdio MCP server runs on Daniel's laptop against the
    PROD backend over HTTP — it has no route to prod's database, so it cannot
    write its own audit row. The in-process gateway writes directly; the HTTP
    gateway posts here. Same table either way, so usage stats cover both
    surfaces.

    Best-effort by contract: the caller ignores failures. Losing an audit row
    must never cost Daniel the tool call that produced it.
    """
    from ..services.mcp_logging import record_call

    name = (body.get("tool_name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="tool_name is required")
    row_id = record_call(
        db,
        tool_name=name,
        source=(body.get("source") or "mcp-stdio"),
        args=body.get("args"),
        status=(body.get("status") or "done"),
        result=body.get("result"),
        error=body.get("error"),
    )
    db.commit()
    return {"ok": True, "id": row_id}


@router.get("/tool-calls/usage")
def tool_call_usage(days: int = 30, db: Session = Depends(get_db)):
    """Per-tool call counts by surface — the read that makes "is this tool
    actually used?" answerable from data instead of memory."""
    from datetime import datetime, timedelta

    from sqlalchemy import func as sqlfunc

    from ..db.models import ToolCall

    cutoff = datetime.utcnow() - timedelta(days=int(days))
    rows = (
        db.query(
            ToolCall.tool_name,
            ToolCall.source,
            ToolCall.status,
            sqlfunc.count(ToolCall.id),
        )
        .filter(ToolCall.started_at >= cutoff)
        .group_by(ToolCall.tool_name, ToolCall.source, ToolCall.status)
        .all()
    )
    out: dict[str, dict] = {}
    for name, source, status, count in rows:
        entry = out.setdefault(name, {"tool_name": name, "total": 0, "by_source": {}, "failed": 0})
        entry["total"] += count
        entry["by_source"][source or "chat"] = entry["by_source"].get(source or "chat", 0) + count
        if status == "failed":
            entry["failed"] += count
    return {
        "days": int(days),
        "tools": sorted(out.values(), key=lambda r: (-r["total"], r["tool_name"])),
    }


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
