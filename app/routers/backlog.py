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


@router.get("/backlog/tickets")
def backlog_list(
    include_done: bool = True,
    sort: str = "default",
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List backlog tickets. sort='default' = sort_order ASC (current
    behavior). sort='urgency' = G2 urgency-first ranking: open tickets
    with urgency_score desc, then non-scored open, then done. Caps at
    `limit` rows on urgency mode to avoid hauling the whole backlog."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    if sort == "urgency":
        # Use the dedicated query — only open + scored tickets, ranked.
        # Fall back to default-sorted remainder for context if include_done.
        scored = backlog_service.list_by_urgency(db, limit=limit)
        scored_ids = {t.id for t in scored}
        out = [serialize_ticket(t) for t in scored]
        # Append non-scored open tickets after the ranked ones so callers
        # paging through don't lose visibility of unscored work. Done
        # tickets only included when include_done=True.
        remainder = [
            t for t in backlog_service.list_all(db, include_done=include_done)
            if t.id not in scored_ids
        ]
        out.extend(serialize_ticket(t) for t in remainder)
        return out
    rows = backlog_service.list_all(db, include_done=include_done)
    return [serialize_ticket(t) for t in rows]


@router.post("/backlog/tickets")
def backlog_create(body: dict, db: Session = Depends(get_db)):
    """Create a backlog ticket. Mirrors /lists/{id}/items conflict
    detection: response carries `conflicts: [{id, text, similarity,
    severity}]` for near-duplicates already on the board, so a caller
    (MCP, FE) can prompt the user to merge instead of stacking dupes.
    Pass `skip_conflict_check: true` to bypass the embed scan (bulk
    imports / migrations).
    """
    from ..services.backlog_service import backlog_service, serialize_ticket
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    ticket = backlog_service.create(
        db,
        text=text_val,
        subtitle=body.get("subtitle"),
        source_note_id=body.get("source_note_id"),
        board_status=body.get("board_status"),
        notes=body.get("notes"),
    )
    out = serialize_ticket(ticket)
    if not body.get("skip_conflict_check"):
        # Severity bands match list_service: 0.92+ = high (almost
        # certainly the same item), 0.85+ = medium, otherwise low.
        text_for_match = text_val
        if body.get("subtitle"):
            text_for_match = f"{text_val}\n{body.get('subtitle')}"
        matches = backlog_service.find_similar(
            db, text=text_for_match, threshold=0.78, limit=5,
        )
        conflicts = []
        for tk, sim in matches:
            if tk.id == ticket.id:
                continue
            severity = "high" if sim >= 0.92 else ("medium" if sim >= 0.85 else "low")
            conflicts.append({
                "id": tk.id, "text": tk.text,
                "similarity": round(sim, 3), "severity": severity,
            })
        if conflicts:
            out["conflicts"] = conflicts
    return out


@router.post("/backlog/tickets/similar")
def backlog_similar(body: dict, db: Session = Depends(get_db)):
    """Cosine-search backlog tickets without inserting. Body:
    {text, threshold?, limit?, include_done?}. Mirrors the
    /lists/{id}/similar shape so MCP find_similar_backlog can match
    find_similar_items's response contract.
    """
    from ..services.backlog_service import backlog_service
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    threshold = float(body.get("threshold", 0.78))
    limit = int(body.get("limit", 5))
    include_done = bool(body.get("include_done", False))
    matches = backlog_service.find_similar(
        db, text=text_val, threshold=threshold, limit=limit,
    )
    out = []
    for tk, sim in matches:
        if not include_done and tk.done:
            continue
        out.append({
            "id": tk.id, "text": tk.text, "subtitle": tk.subtitle,
            "similarity": round(sim, 3),
            "board_status": tk.board_status,
            "done": bool(tk.done),
        })
    return {"matches": out}


@router.patch("/backlog/tickets/{ticket_id}")
def backlog_update(ticket_id: int, body: dict, db: Session = Depends(get_db)):
    from ..services.backlog_service import backlog_service, serialize_ticket
    patch: dict = {}
    for key in (
        "text", "subtitle", "board_status", "pr_url", "done", "sort_order",
        "notes", "claimed_by",
    ):
        if key in body:
            patch[key] = body[key]
    ticket = backlog_service.update(db, ticket_id, **patch)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)


@router.delete("/backlog/tickets/{ticket_id}")
def backlog_delete(ticket_id: int, db: Session = Depends(get_db)):
    from ..services.backlog_service import backlog_service
    if not backlog_service.delete(db, ticket_id):
        raise HTTPException(status_code=404, detail="ticket not found")
    return {"ok": True}


@router.get("/backlog/tickets/primary")
def backlog_get_primary(db: Session = Depends(get_db)):
    """Singleton dashboard north-star ticket — or null when nothing is
    pinned. Drives the PrimaryBacklogBanner on the dashboard."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.get_primary(db)
    return serialize_ticket(ticket) if ticket else None


@router.post("/backlog/tickets/{ticket_id}/promote-to-primary")
def backlog_promote_to_primary(ticket_id: int, db: Session = Depends(get_db)):
    """Pin this ticket as the singleton primary (banner anchor). Clears
    any previously-primary ticket atomically. Idempotent."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.promote_to_primary(db, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)


@router.post("/backlog/tickets/primary/clear")
def backlog_clear_primary(db: Session = Depends(get_db)):
    """Unpin whichever ticket currently holds primary. Returns the
    demoted ticket or null when nothing was pinned."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.clear_primary(db)
    return serialize_ticket(ticket) if ticket else None


@router.post("/backlog/tickets/{ticket_id}/promote")
def backlog_promote(ticket_id: int, db: Session = Depends(get_db)):
    """Create a Todo mirroring this ticket and link them via ticket.todo_id.
    Returns {ticket, todo}. Idempotent — re-promoting an already-linked
    ticket returns the existing pair."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    from ..services.todo_service import serialize_todo
    result = backlog_service.promote(db, ticket_id)
    if result is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    ticket, todo = result
    return {"ticket": serialize_ticket(ticket), "todo": serialize_todo(todo)}


@router.post("/backlog/tickets/{ticket_id}/demote")
def backlog_demote(ticket_id: int, db: Session = Depends(get_db)):
    """Sever the ticket↔todo link by deleting the linked Todo and clearing
    ticket.todo_id. Backlog row stays."""
    from ..services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.demote(db, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)
