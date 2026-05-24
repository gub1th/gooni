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


@router.get("/habits")
def habits_list(db: Session = Depends(get_db)):
    """Active habits w/ each habit's 7-day strip + current streak. Drives
    the dashboard widget. Sorted by sort_order, id."""
    from ..services import habit_service
    rows = habit_service.list_active(db)
    return [
        habit_service.serialize_habit(h, include_derived=True, db=db)
        for h in rows
    ]


@router.post("/habits")
def habits_create(body: dict, db: Session = Depends(get_db)):
    """Create a habit. Body: {name, polarity?, color?}. Polarity
    defaults to 'positive'."""
    from ..services import habit_service
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    polarity = body.get("polarity") or "positive"
    if polarity not in ("positive", "negative"):
        raise HTTPException(400, "polarity must be 'positive' or 'negative'")
    h = habit_service.create(
        db, name=name, polarity=polarity, color=body.get("color"),
    )
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@router.patch("/habits/{habit_id}")
def habits_patch(habit_id: int, body: dict, db: Session = Depends(get_db)):
    """Rename / recolor / archive. Body any of {name, color, polarity,
    sort_order, archived: bool}."""
    from ..services import habit_service
    h = habit_service.update(db, habit_id, **body)
    if not h:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@router.delete("/habits/{habit_id}")
def habits_delete(habit_id: int, db: Session = Depends(get_db)):
    """Hard delete. Entries cascade."""
    from ..services import habit_service
    ok = habit_service.delete(db, habit_id)
    if not ok:
        raise HTTPException(404, "habit not found")
    return {"deleted": True}


@router.put("/habits/{habit_id}/entries/{day}")
def habit_entry_upsert(
    habit_id: int, day: str, body: dict, db: Session = Depends(get_db),
):
    """Upsert one day's entry. Path `day` = YYYY-MM-DD. Body:
    {value: bool, note?: str}."""
    from ..services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    if "value" not in body:
        raise HTTPException(400, "value required (bool)")
    e = habit_service.upsert_entry(
        db, habit_id, d, bool(body["value"]), note=body.get("note"),
    )
    if not e:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_entry(e)


@router.delete("/habits/{habit_id}/entries/{day}")
def habit_entry_unlog(
    habit_id: int, day: str, db: Session = Depends(get_db),
):
    """Delete one day's entry — reverts to unknown."""
    from ..services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    deleted = habit_service.unlog_entry(db, habit_id, d)
    return {"deleted": deleted}
