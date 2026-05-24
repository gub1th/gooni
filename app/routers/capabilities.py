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


@router.get("/capabilities")
def list_capabilities(db: Session = Depends(get_db)):
    """List all user-visible capability facets grouped by layer.

    Skips the `_meta` layer (internal scan-hash sentinel). Status='removed'
    rows are returned so the FE can render them dimmed — useful for "Gooni
    used to do X but a refactor removed it."
    """
    rows = (
        db.query(CapabilityFacet)
        .filter(CapabilityFacet.layer != "_meta")
        .order_by(CapabilityFacet.layer, CapabilityFacet.id)
        .all()
    )
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.layer, []).append(_serialize_capability_facet(r))
    return {"by_layer": out, "total": len(rows)}


@router.patch("/capabilities/{facet_id}")
def patch_capability(facet_id: int, body: dict, db: Session = Depends(get_db)):
    """Hand-edit a facet. Allowed fields: facet_text, status, layer.
    Source flips to 'chat_tool_update' to mark provenance.
    """
    row = db.query(CapabilityFacet).filter(CapabilityFacet.id == facet_id).one_or_none()
    if row is None:
        raise HTTPException(404, "facet not found")
    if "facet_text" in body:
        new_text = (body["facet_text"] or "").strip()
        if new_text:
            row.facet_text = new_text
    if "status" in body:
        new_status = str(body["status"])
        if new_status not in {"claimed", "verified", "unverified", "broken", "removed"}:
            raise HTTPException(400, "invalid status")
        row.status = new_status
    if "layer" in body:
        new_layer = str(body["layer"])
        if new_layer not in {"mechanical", "functional", "behavioral", "architectural"}:
            raise HTTPException(400, "invalid layer")
        row.layer = new_layer
    row.source = "chat_tool_update"
    db.commit()
    return _serialize_capability_facet(row)


@router.post("/capabilities")
def create_capability(body: dict, db: Session = Depends(get_db)):
    """Create a facet manually (Daniel-seeded functional/architectural rows).
    facet_key must be unique; conflicts return 409.
    """
    facet_key = (body.get("facet_key") or "").strip()
    layer = (body.get("layer") or "").strip()
    facet_text = (body.get("facet_text") or "").strip()
    if not facet_key or not layer or not facet_text:
        raise HTTPException(400, "facet_key, layer, facet_text required")
    if layer not in {"mechanical", "functional", "behavioral", "architectural"}:
        raise HTTPException(400, "invalid layer")
    existing = db.query(CapabilityFacet).filter(CapabilityFacet.facet_key == facet_key).one_or_none()
    if existing is not None:
        raise HTTPException(409, "facet_key already exists")
    row = CapabilityFacet(
        facet_key=facet_key,
        layer=layer,
        facet_text=facet_text,
        status=str(body.get("status") or "claimed"),
        source=str(body.get("source") or "manual_seed"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_capability_facet(row)


@router.post("/capabilities/telemetry/refresh")
def trigger_capability_telemetry(db: Session = Depends(get_db)):
    """Manual trigger for the runtime-telemetry rollup. Same op the nightly
    lifespan loop fires at 03:00 local. Useful for FE-driven 'refresh now'.
    """
    from ..services.capability_service import capability_service
    return capability_service.run_telemetry_rollup(db)


@router.post("/capabilities/boot-scan/refresh")
def trigger_capability_boot_scan(db: Session = Depends(get_db)):
    """Manual trigger for the boot-time mechanical-layer scan. Same op the
    lifespan startup hook fires. Use when you've added a tool/route mid-session
    without restarting uvicorn."""
    from ..services.capability_service import capability_service
    return capability_service.refresh_mechanical_layer(db)


@router.post("/capabilities/dedup-behavioral")
def trigger_capability_dedup_behavioral(db: Session = Depends(get_db)):
    """One-shot cleanup over existing behavioral facets — cosine-clusters them
    and merges semantic dups into the oldest canonical row. Use after the
    cosine-dedup-at-promotion-time fix lands to clean the historical bloat
    (prod was carrying ~6 near-identical "I tend to: lack support" facets
    because the old promote path keyed on text hash, not embedding).

    Returns {scanned, kept, merged, clusters} — clusters lists the canon
    row + merged ids so the audit is auditable.
    """
    from ..services.capability_service import capability_service
    return capability_service.dedup_existing_behavioral(db)
