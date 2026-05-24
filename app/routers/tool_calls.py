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
