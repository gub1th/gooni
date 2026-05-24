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


@router.get("/notes/{note_id}/comments")
def list_note_comments(note_id: int, db: Session = Depends(get_db)):
    """All comments on a note, oldest first. Mirrors how Confluence threads
    read top-down so newest replies stay at the bottom of the editor."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    rows = (
        db.query(NoteComment)
        .filter(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc(), NoteComment.id.asc())
        .all()
    )
    return [_serialize_comment(c) for c in rows]


@router.post("/notes/{note_id}/comments")
def create_note_comment(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Append a comment. `author` defaults to "daniel" when the request
    doesn't supply one — Claude/Gooni pass their own label via the MCP tool
    so the bubble can show who wrote it."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    author = (body.get("author") or "daniel").strip() or "daniel"
    c = NoteComment(note_id=note_id, author=author, content=content)
    db.add(c)
    db.commit()
    db.refresh(c)
    return _serialize_comment(c)


@router.delete("/comments/{comment_id}")
def delete_note_comment(comment_id: int, db: Session = Depends(get_db)):
    c = db.query(NoteComment).filter(NoteComment.id == comment_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    db.delete(c)
    db.commit()
    return {"ok": True}
