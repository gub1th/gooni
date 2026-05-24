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


@router.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    # Pinned spaces sort to the top — within each pinned/un-pinned group,
    # keep the historical id-asc order so existing sidebar muscle memory
    # stays intact.
    spaces = (
        db.query(Space)
        .order_by(Space.is_pinned.desc(), Space.id.asc())
        .all()
    )
    return [_serialize_space(s) for s in spaces]


@router.post("/spaces")
def create_space(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    space = Space(name=name)
    db.add(space)
    db.commit()
    db.refresh(space)
    return {"id": space.id, "name": space.name, "emoji": space.emoji}


@router.patch("/spaces/{space_id}")
def update_space(space_id: int, body: dict, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    if "name" in body:
        name = body["name"].strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        space.name = name
    if "emoji" in body:
        space.emoji = body["emoji"] or None
    if "is_pinned" in body:
        space.is_pinned = bool(body["is_pinned"])
    if "description" in body:
        # Trim trailing whitespace; collapse empty-string to NULL so the
        # serializer reports `null` instead of "" (saves the frontend a
        # special-case check for "is this really set?").
        desc = body["description"]
        space.description = (desc or "").strip() or None
    if "cover_image_url" in body:
        url = body["cover_image_url"]
        space.cover_image_url = (url or "").strip() or None
    db.commit()
    db.refresh(space)
    return _serialize_space(space)


@router.delete("/spaces/{space_id}")
def delete_space(space_id: int, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    db.query(Note).filter(Note.space_id == space_id).delete()
    db.delete(space)
    db.commit()
    return {"ok": True}


@router.get("/spaces/{space_id}/stats")
def get_space_stats(space_id: int, db: Session = Depends(get_db)):
    """Lightweight stats for a space's header — note count, most-recent
    touch, top-3 tags. One query per metric, all unindexed columns are
    fine at our note volume."""
    from sqlalchemy import func as sqlfunc

    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    note_count = (
        db.query(sqlfunc.count(Note.id))
        .filter(Note.space_id == space_id)
        .scalar()
    ) or 0
    last_touched = (
        db.query(
            sqlfunc.max(
                sqlfunc.coalesce(Note.updated_at, Note.last_opened_at, Note.created_at)
            )
        )
        .filter(Note.space_id == space_id)
        .scalar()
    )
    # Top-3 tags by frequency — read raw `tags` JSON-text and tally. Note
    # cardinality per space stays small enough that we don't need a
    # materialized rollup table; a Python tally is fine.
    tag_rows = (
        db.query(Note.tags)
        .filter(Note.space_id == space_id, Note.tags.is_not(None))
        .all()
    )
    counts: dict[str, int] = {}
    for (raw,) in tag_rows:
        for t in _parse_tags(raw):
            counts[t] = counts.get(t, 0) + 1
    top_tags = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {
        "space_id": space_id,
        "note_count": note_count,
        "last_touched": last_touched.isoformat() if last_touched else None,
        "top_tags": [{"tag": t, "count": c} for t, c in top_tags],
    }


@router.get("/spaces/{space_id}/notes")
def get_space_notes(space_id: str, db: Session = Depends(get_db)):
    if space_id == "general":
        notes = db.query(Note).order_by(_notes_order()).all()
    else:
        notes = (
            db.query(Note)
            .filter(Note.space_id == int(space_id))
            .order_by(_notes_order())
            .all()
        )
    return [_serialize_note_lite(n) for n in notes]


@router.post("/spaces/{space_id}/notes")
def create_space_note(space_id: str, body: dict, db: Session = Depends(get_db)):
    from datetime import datetime

    numeric_id = None if space_id == "general" else int(space_id)
    initial_content = body.get("content") or ""
    initial_tags = _normalize_tags(body.get("tags") or [])
    # G3 publish ceremony: every new note enters as a draft (Confluence
    # pattern). The Publish action — POST /notes/{id}/publish — is the
    # explicit transition from draft → published, where the user picks
    # public or private. Callers can still pass is_draft=False to bypass
    # the ceremony for programmatic creates (eval seed, MCP add_note).
    note = Note(
        title=body.get("title") or "",
        content=initial_content,
        excerpt=_excerpt_from_html(initial_content),
        space_id=numeric_id,
        is_draft=bool(body.get("is_draft", True)),
        is_pinned=bool(body.get("is_pinned", False)),
        tags=json.dumps(initial_tags) if initial_tags else None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    # G3 Note→Focus binding: embed title + first 500 chars of HTML-stripped
    # content, cosine-match active focuses, wire `supports` edge if it
    # clears the floor. Skipped when title + content are empty.
    try:
        from ..services import focus_binding
        from ..services.list_service import list_service
        text_seed = (note.title or "").strip()
        body_text = _excerpt_from_html(initial_content, limit=500) or ""
        if body_text:
            text_seed = f"{text_seed} {body_text}".strip()
        if text_seed:
            emb = list_service._embed_item_text(text_seed)
            if emb:
                focus_binding.bind_to_focus(
                    db, src_kind="note", src_id=note.id, embedding=emb
                )
    except Exception as e:
        print(f"[create_space_note] note→focus bind failed: {e}")

    return _serialize_note(note)
