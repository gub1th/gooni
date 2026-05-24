
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services.memory_service import memory_service
from ..services.note_service import note_service

from ..serializers import (
    _serialize_note
)


router = APIRouter()


@router.get("/mcp/context")
def mcp_get_context(q: str = "", db: Session = Depends(get_db)):
    """Return memory context for a query."""
    if not q.strip():
        return {"context": ""}
    context = memory_service.build_memory_context(q, db=db)
    return {"context": context}


@router.post("/mcp/memories")
def mcp_add_memory(body: dict, db: Session = Depends(get_db)):
    """Add a memory directly (bypasses extraction). Used by MCP."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    memory_service.add_memory(content, db=db)
    return {"ok": True}


@router.get("/mcp/memories/search")
def mcp_search_memories(q: str, limit: int = 10, db: Session = Depends(get_db)):
    """Search memories by semantic similarity."""
    memories = memory_service.search(q, limit=limit, db=db)
    return [{"id": m.get("id"), "memory": m.get("memory")} for m in memories]


@router.patch("/mcp/memories/{memory_id}")
def mcp_edit_memory(memory_id: str, body: dict, db: Session = Depends(get_db)):
    """Update a memory by ID via supersede chain."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if not memory_service.update_memory(memory_id, content, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@router.delete("/mcp/memories/{memory_id}")
def mcp_forget_memory(memory_id: str, db: Session = Depends(get_db)):
    """Soft-delete a memory (is_active=False)."""
    if not memory_service.delete(memory_id, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@router.get("/mcp/notes/search")
def mcp_search_notes(q: str, limit: int = 5, db: Session = Depends(get_db)):
    """Search notes by semantic similarity to a query string."""
    related = note_service.search_by_query(q, limit, db)
    return [_serialize_note(n) for n in related]
