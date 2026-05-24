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
