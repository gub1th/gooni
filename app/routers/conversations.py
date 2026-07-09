import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Conversation,
)
from ..llm.client import llm_client
from ..services.conversation_service import conversation_service
from ..services.orchestrator import Orchestrator

from ..serializers import (
    _serialize_conversation, _serialize_message
)


router = APIRouter()


def _build_feed(
    db: Session,
    general: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Conversations sorted newest first (Spaces died in the v2 nuke, so
    `general` is now always effectively True — the param is kept for the
    one caller's call-site shape)."""
    q = db.query(Conversation).filter(Conversation.source != "telegram")

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


# ── Ambient-loop v2 Slice 3: the log + glow surface ─────────────────────


@router.get("/messages/log")
def messages_log(
    limit: int = 100,
    before_id: int | None = None,
    db: Session = Depends(get_db),
):
    """Flat append-only message log across ALL conversations/sources —
    the ChatLogView substrate. Newest first; paginate with before_id.
    Each row carries the conversation source so the log can badge
    where a thought came from (web / whatsapp / telegram)."""
    from ..db.models import Message

    limit = max(1, min(limit, 300))
    q = (
        db.query(Message, Conversation.source)
        .join(Conversation, Message.conversation_id == Conversation.id)
    )
    if before_id is not None:
        q = q.filter(Message.id < before_id)
    rows = q.order_by(Message.id.desc()).limit(limit).all()
    out = []
    for m, source in rows:
        d = _serialize_message(m)
        d["source"] = source
        out.append(d)
    return out


def _glow_message(db: Session, message_id: int):
    from ..db.models import Message

    msg = db.query(Message).filter(Message.id == message_id).first()
    if msg is None:
        raise HTTPException(404, "Message not found")
    if not msg.has_actionable_signal or not msg.signal_preview:
        raise HTTPException(400, "message carries no actionable signal")
    try:
        preview = json.loads(msg.signal_preview)
    except (TypeError, ValueError):
        raise HTTPException(400, "signal_preview unreadable")
    return msg, preview


@router.post("/messages/{message_id}/promote")
def promote_message(message_id: int, db: Session = Depends(get_db)):
    """1-click promote: create Promise(s) from the glow's parsed drafts.
    Runs the full promise_service create pipeline (due resolution, parent
    hint, dedup, evaluator) with this message as the source utterance.
    Stamps promise_ids on the preview so undo can reverse exactly."""
    from ..services import promise_service

    msg, preview = _glow_message(db, message_id)
    if preview.get("status") == "promoted":
        raise HTTPException(409, "already promoted (undo first)")

    created = []
    for sp in preview.get("signals") or []:
        try:
            p = promise_service.create_from_signal(db, sp, source_message_id=msg.id)
        except Exception as e:
            print(f"[promote] create_from_signal failed: {e}")
            p = None
        if p is not None:
            created.append(p)
    if not created:
        raise HTTPException(400, "no promotable signals on this message")

    preview["status"] = "promoted"
    preview["promise_ids"] = [p.id for p in created]
    msg.signal_preview = json.dumps(preview)
    db.commit()

    from ..serializers import _serialize_promise
    return {
        "message": _serialize_message(msg),
        "promises": [_serialize_promise(p) for p in created],
    }


@router.post("/messages/{message_id}/undo-promote")
def undo_promote(message_id: int, db: Session = Depends(get_db)):
    """Undo a promote within the FE's countdown window: hard-delete the
    created promises (+ their edges) and restore the glow-untapped state.
    Idempotent-ish — undoing a non-promoted glow 409s."""
    from ..services import promise_service

    msg, preview = _glow_message(db, message_id)
    if preview.get("status") != "promoted":
        raise HTTPException(409, "message is not in promoted state")
    for pid in preview.get("promise_ids") or []:
        try:
            promise_service.delete(db, pid)
        except Exception as e:
            print(f"[undo-promote] delete {pid} failed: {e}")
    preview["status"] = "pending"
    preview["promise_ids"] = []
    msg.signal_preview = json.dumps(preview)
    db.commit()
    return {"message": _serialize_message(msg)}


@router.post("/messages/{message_id}/dismiss-glow")
def dismiss_glow(message_id: int, db: Session = Depends(get_db)):
    """Dismiss without acting — the glow dot clears, the parse is kept
    for provenance. Signals Gooni that Daniel didn't care about this one."""
    msg, preview = _glow_message(db, message_id)
    if preview.get("status") == "promoted":
        raise HTTPException(409, "already promoted (undo first)")
    preview["status"] = "dismissed"
    msg.signal_preview = json.dumps(preview)
    db.commit()
    return {"message": _serialize_message(msg)}
