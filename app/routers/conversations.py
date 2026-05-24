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


def _build_feed(
    db: Session,
    space_id: int | None = None,
    general: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Conversations sorted newest first.

    - general=True: return everything (no filter)
    - space_id set: filter by space
    """
    q = db.query(Conversation).filter(Conversation.source != "telegram")

    if not general and space_id is not None:
        q = q.filter(Conversation.space_id == space_id)

    items = [_serialize_conversation(c) for c in q.all()]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:limit]


@router.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    return _build_feed(db, general=True)


@router.post("/conversations")
async def create_general_conversation(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(db=db, source="web", title=title)
    return _serialize_conversation(conv)


@router.get("/conversations/{conversation_id}/messages")
def get_conversation_messages(conversation_id: int, db: Session = Depends(get_db)):
    msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in msgs]


@router.post("/conversations/{conversation_id}/seed")
def seed_conversation(conversation_id: int, body: dict, db: Session = Depends(get_db)):
    """Entry content becomes the first user message; Orchestrator generates Claude's reply."""
    entry_content = body.get("entry_content", "").strip()
    if not entry_content:
        return []
    try:
        Orchestrator.handle_chat(entry_content, db, conversation_id=conversation_id)
        msgs = conversation_service.get_messages(conversation_id, db)
        return [_serialize_message(m) for m in msgs]
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/conversations/{conversation_id}/messages")
def send_conversation_message(
    conversation_id: int, body: dict, db: Session = Depends(get_db)
):
    """Send a user message; returns full thread after Claude replies."""
    user_content = body.get("content", "").strip()
    image_url = body.get("image_url") or None
    if not user_content and not image_url:
        raise HTTPException(status_code=400, detail="content or image_url is required")
    entry_content = body.get("entry_content", "")
    model = body.get("model") or None
    try:
        _, usage = Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
            model=model,
            image_url=image_url,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return {
        "messages": [_serialize_message(m) for m in msgs],
        "intention": usage.get("intention") or "",
        "tools_used": usage.get("tools_used") or [],
    }


@router.post("/conversations/{conversation_id}/messages/stream")
def send_conversation_message_stream(
    conversation_id: int, body: dict,
):
    """SSE variant of /messages. Same payload, but streams pipeline events
    so the web chat UI can show "Thinking…" → tool cards in flight →
    final reply land progressively.

    Events emitted (one per `data:` line, JSON):
      - {"type":"stage","stage":"intent|memory_recall|generate","label":"..."}
      - {"type":"tool_start","id":N,"tool_name":"...","args":{...}}
      - {"type":"tool_done","id":N,"tool_name":"...","status":"done|failed","error":...}
      - {"type":"done","messages":[...],"intention":"...","tools_used":[...]}
      - {"type":"error","message":"..."}

    The endpoint takes no db Session via Depends — the chat path runs in
    a background thread with its own session, so the request handler stays
    free to stream events as fast as the queue drains.

    Bot channels (telegram/whatsapp/imessage) do NOT use this — they go
    through the non-streaming /messages endpoint.
    """
    from fastapi.responses import StreamingResponse
    from threading import Thread
    from queue import Queue, Empty

    user_content = (body.get("content") or "").strip()
    image_url = body.get("image_url") or None
    if not user_content and not image_url:
        raise HTTPException(status_code=400, detail="content or image_url is required")
    entry_content = body.get("entry_content", "")
    model = body.get("model") or None

    queue: Queue = Queue()
    SENTINEL = object()

    def _worker():
        # Background thread owns its own DB session — the FastAPI-managed
        # session can't cross threads safely. SessionLocal is the same
        # factory get_db uses for HTTP-bound work.
        from ..db.database import SessionLocal
        worker_db = SessionLocal()
        try:
            try:
                _, usage = Orchestrator.handle_chat(
                    user_content,
                    worker_db,
                    conversation_id=conversation_id,
                    entry_content=entry_content,
                    model=model,
                    image_url=image_url,
                    event_cb=queue.put,
                )
                msgs = conversation_service.get_messages(conversation_id, worker_db)
                queue.put({
                    "type": "done",
                    "messages": [_serialize_message(m) for m in msgs],
                    "intention": (usage or {}).get("intention") or "",
                    "tools_used": (usage or {}).get("tools_used") or [],
                })
            except ValueError as e:
                queue.put({"type": "error", "message": str(e)})
            except Exception as e:
                # Same swallow-but-surface posture as the non-streaming path:
                # never crash the SSE stream — emit an error event the
                # frontend can render.
                queue.put({"type": "error", "message": f"chat failed: {e}"})
        finally:
            queue.put(SENTINEL)
            worker_db.close()

    Thread(target=_worker, daemon=True).start()

    def _event_source():
        while True:
            try:
                # Heartbeat every 15s so reverse proxies (Fly's edge) don't
                # idle-kill the SSE connection on long replies.
                evt = queue.get(timeout=15.0)
            except Empty:
                yield ": heartbeat\n\n"
                continue
            if evt is SENTINEL:
                break
            yield f"data: {json.dumps(evt, default=str)}\n\n"

    return StreamingResponse(
        _event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disables nginx-style buffering at the edge
            "Connection": "keep-alive",
        },
    )


@router.get("/conversations/{conversation_id}/graph")
def get_conversation_graph(conversation_id: int, db: Session = Depends(get_db)):
    """Topic graph for the chat-flow visualization in GooniPanel. Cached on
    the conversation row by message count — a new turn invalidates."""
    return conversation_service.build_topic_graph(conversation_id, db)
