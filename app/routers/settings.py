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


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _serialize_settings(_settings_row(db))


@router.patch("/settings")
def patch_settings(body: dict, db: Session = Depends(get_db)):
    s = _settings_row(db)
    if "nudge_enabled" in body:
        s.nudge_enabled = bool(body["nudge_enabled"])
    if "nudge_hour" in body:
        h = int(body["nudge_hour"])
        if not 0 <= h <= 23:
            raise HTTPException(status_code=400, detail="nudge_hour must be 0-23")
        s.nudge_hour = h
    if "nudge_minute" in body:
        m = int(body["nudge_minute"])
        if not 0 <= m <= 59:
            raise HTTPException(status_code=400, detail="nudge_minute must be 0-59")
        s.nudge_minute = m
    if "nudge_tz" in body:
        tz = (body["nudge_tz"] or "").strip()
        # Validate via zoneinfo so we fail fast on typos rather than at next fire.
        if ZoneInfo is not None:
            try:
                ZoneInfo(tz)
            except Exception:
                raise HTTPException(status_code=400, detail=f"unknown timezone: {tz!r}")
        s.nudge_tz = tz
    if "nudge_channels" in body:
        chans = body["nudge_channels"]
        if not isinstance(chans, list) or not all(isinstance(c, str) for c in chans):
            raise HTTPException(status_code=400, detail="nudge_channels must be list[str]")
        valid = {"telegram", "whatsapp"}
        bad = [c for c in chans if c not in valid]
        if bad:
            raise HTTPException(status_code=400, detail=f"unknown channel(s): {bad}")
        s.nudge_channels = json.dumps(chans)
    if "nudge_prompt" in body:
        # No length cap server-side — Daniel writes whatever instruction he
        # wants and the LLM cost scales with it. Empty string == use default.
        s.nudge_prompt = (body["nudge_prompt"] or "").strip()
    db.commit()
    db.refresh(s)
    return _serialize_settings(s)


@router.get("/settings/nudge-prompt-default")
def get_nudge_prompt_default():
    """Returns the bundled default digest prompt so the UI's "Use default"
    button doesn't have to mirror the string client-side."""
    return {"prompt": NUDGE_DEFAULT_PROMPT}


@router.post("/settings/test-nudge")
async def test_nudge():
    """Fire the nudge immediately, bypassing the same-day idempotency guard.
    Returns the report from the fan-out so the UI can show what landed."""
    return await _fire_nudge_once(force=True)
