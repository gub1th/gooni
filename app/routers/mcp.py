import hashlib
import hmac
import json
import os
import re
import time

from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, Header, HTTPException, Request, UploadFile
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..db.database import engine, get_db, SessionLocal
from ..db.models import (
    Attachment,
    CapabilityFacet,
    Conversation,
    GooniTake,
    McpCall,
    Memory,
    Message,
    List as ListModel,
    ListItem,
    Note,
    NoteComment,
    PublicProfile,
    Reaction,
    Reflection,
    Settings,
    Space,
    Visit,
    WaProcessedId,
)
from ..db.schemas import ChatRequest
from ..llm.client import llm_client
from ..services.conversation_service import conversation_service
from ..services.item_service import item_service
from ..services.memory_service import memory_service
from ..services.messaging import (
    dispatch_inbound,
    imessage_channel,
    telegram_channel,
    whatsapp_channel,
)
from ..services.note_service import note_service
from ..services.orchestrator import Orchestrator
from ..services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
    compose_message as compose_nudge_message,
)

from ..serializers import (
    _TAG_RE, _IMG_TAG_RE, _WHITESPACE_RE, _EXTERNAL_IMG_SRC_RE, _REACTION_TARGETS, _REACTION_MAX_EMOJI_LEN, _REACTION_MAX_REACTOR_LEN, _excerpt_from_html, _strip_html_to_visible_text, _external_thumb_from_html, _note_excerpt, _parse_tags, _normalize_tags, _serialize_note, _serialize_note_lite, _notes_order, _serialize_list, _serialize_list_item, _serialize_item, _serialize_space, _serialize_settings, _serialize_promise, _serialize_comment, _validate_reaction_target, _serialize_reactions, _serialize_conversation, _serialize_message, _serialize_capability_facet, _serialize_reflection
)
from ..common import (
    _AUTH_PASSWORD, _expected_token, _parse_iso_date, _parse_optional_due, _parse_optional_dt, _validate_health, _validate_status, _validate_scale, _VALID_STATUS, _VALID_SCALE, _unique_viewers_for_note
)
from ..deps import _fire_nudge_once, _settings_row, _next_fire


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
