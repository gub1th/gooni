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


def _memory_to_dashboard(m) -> dict:
    """Full row shape for the dashboard table. Skips embedding (huge JSON
    string) since the table never displays it."""
    return {
        "id": m.id,
        "type": m.type,
        "key": m.key,
        "content": m.content,
        "confidence": m.confidence,
        "is_active": bool(m.is_active),
        "superseded_by": m.superseded_by,
        "focus_id": m.focus_id,
        "retrieval_count": m.retrieval_count,
        "last_retrieved_at": m.last_retrieved_at.isoformat() if m.last_retrieved_at else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


@router.get("/memories")
def list_memories(
    type: str | None = None,
    q: str | None = None,
    include_inactive: bool = False,
    limit: int = 200,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """List memories for the dashboard. Filters by type (optional), text
    substring (optional), and active flag. Paged via limit/offset. Newest
    first."""
    from ..db.models import Memory  # local to avoid circular at import time
    query = db.query(Memory)
    if not include_inactive:
        query = query.filter(Memory.is_active == True)  # noqa: E712
    if type:
        query = query.filter(Memory.type == type)
    if q:
        # Case-insensitive content substring match — cheap, works without FTS.
        query = query.filter(Memory.content.ilike(f"%{q}%"))
    total = query.count()
    rows = query.order_by(Memory.created_at.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "memories": [_memory_to_dashboard(m) for m in rows],
    }


@router.get("/memories/stats")
def memory_stats(db: Session = Depends(get_db)):
    """Counts per type for the dashboard header tabs."""
    from ..db.models import Memory
    from sqlalchemy import func as sqlfunc
    rows = (
        db.query(Memory.type, sqlfunc.count(Memory.id))
        .filter(Memory.is_active == True)  # noqa: E712
        .group_by(Memory.type)
        .all()
    )
    return {
        "total": sum(c for _, c in rows),
        "by_type": {t: c for t, c in rows},
    }


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: int, db: Session = Depends(get_db)):
    """Soft-delete (is_active=False). Same as MCP forget."""
    if not memory_service.delete(memory_id, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@router.patch("/memories/{memory_id}")
def edit_memory(memory_id: int, body: dict, db: Session = Depends(get_db)):
    """Update content (supersede chain, preserves audit history) and/or
    type. Type change is in-place — no new row — since type taxonomy
    shifts are a metadata correction rather than a content change.
    Pass `content` to update text, `type` to change taxonomy, or both.
    """
    from ..db.models import Memory
    content = (body.get("content") or "").strip()
    new_type = (body.get("type") or "").strip().lower() or None
    if not content and not new_type:
        raise HTTPException(status_code=400, detail="content or type is required")
    if content:
        if not memory_service.update_memory(memory_id, content, db=db):
            raise HTTPException(status_code=404, detail="memory not found")
    if new_type:
        from ..services.memory_extraction import VALID_TYPES
        # `preference` is no longer in VALID_TYPES (extraction was disabled
        # there), but we still need to accept it as a target type for
        # legacy rows. Add it back to the allowed set just for this PATCH.
        allowed = VALID_TYPES | {"preference"}
        if new_type not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"type must be one of {sorted(allowed)}",
            )
        row = db.query(Memory).filter(Memory.id == memory_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="memory not found")
        row.type = new_type
        db.commit()
    return {"ok": True, "id": memory_id}
