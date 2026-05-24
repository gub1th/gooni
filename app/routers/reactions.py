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


@router.get("/reactions")
def list_reactions(
    target_type: str,
    target_id: int,
    reactor_id: str | None = None,
    db: Session = Depends(get_db),
):
    """Per-emoji counts for the target, plus `reacted_by_me` flag when
    the caller supplies their reactor_id. Anonymous callers omit it and
    get bare counts."""
    _validate_reaction_target(target_type, target_id, db)
    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .all()
    )
    return _serialize_reactions(rows, reactor_id)


@router.post("/reactions")
def toggle_reaction(body: dict, db: Session = Depends(get_db)):
    """Toggle a reaction: remove if (target, emoji, reactor_id) already
    exists, else insert. Returns the refreshed per-emoji bucket set.

    Body: { target_type, target_id, emoji, reactor_id }
    """
    target_type = (body.get("target_type") or "").strip()
    target_id_raw = body.get("target_id")
    emoji = (body.get("emoji") or "").strip()
    reactor_id = (body.get("reactor_id") or "").strip()
    try:
        target_id = int(target_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="target_id must be an integer")
    if not emoji or len(emoji) > _REACTION_MAX_EMOJI_LEN:
        raise HTTPException(status_code=400, detail="emoji required (≤32 chars)")
    if not reactor_id or len(reactor_id) > _REACTION_MAX_REACTOR_LEN:
        raise HTTPException(status_code=400, detail="reactor_id required (≤80 chars)")
    _validate_reaction_target(target_type, target_id, db)

    existing = (
        db.query(Reaction)
        .filter(
            Reaction.target_type == target_type,
            Reaction.target_id == target_id,
            Reaction.emoji == emoji,
            Reaction.reactor_id == reactor_id,
        )
        .first()
    )
    if existing:
        db.delete(existing)
    else:
        db.add(Reaction(
            target_type=target_type,
            target_id=target_id,
            emoji=emoji,
            reactor_id=reactor_id,
        ))
    db.commit()

    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .all()
    )
    return _serialize_reactions(rows, reactor_id)
