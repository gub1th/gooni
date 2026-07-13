
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services.memory_service import memory_service

from ..serializers import (
    _memory_to_dashboard
)


router = APIRouter()


@router.get("/memories")
def list_memories(
    type: str | None = None,
    q: str | None = None,
    include_inactive: bool = False,
    limit: int = 200,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """List memories for the dashboard. Filters by type (optional), text
    substring (optional), and active flag. Paged via limit/offset. Newest
    first."""
    from ..db.models import Memory  # local to avoid circular at import time
    query = db.query(Memory)
    if not include_inactive:
        query = query.filter(Memory.is_active == True)  # noqa: E712
    if type:
        query = query.filter(Memory.type == type)
    if q:
        # Case-insensitive content substring match — cheap, works without FTS.
        query = query.filter(Memory.content.ilike(f"%{q}%"))
    total = query.count()
    rows = query.order_by(Memory.created_at.desc()).offset(offset).limit(limit).all()
    serialized = [_memory_to_dashboard(m) for m in rows]
    _attach_sources(serialized, rows, db)
    return {
        "total": total,
        "memories": serialized,
    }


def _attach_sources(serialized: list[dict], rows: list, db: Session) -> None:
    """Resolve each memory's provenance into a displayable `source` object
    (note title, or chat message preview + channel), in two batch queries so
    the list stays O(1) round-trips. `source` is None for memories with no
    recorded origin (chat memories created before provenance shipped, or the
    always-injected prefs). Mutates `serialized` in place."""
    from ..db.models import Conversation, Message, Note

    msg_ids = {m.source_message_id for m in rows if m.source_message_id}
    note_ids = {m.source_note_id for m in rows if m.source_note_id}

    msg_map: dict[int, dict] = {}
    if msg_ids:
        msgs = db.query(
            Message.id, Message.content, Message.conversation_id, Message.created_at,
        ).filter(Message.id.in_(msg_ids)).all()
        # Channel (web/whatsapp/telegram/imessage) lives on the Conversation,
        # not the Message — resolve it in one more batch query.
        conv_ids = {conv_id for _, _, conv_id, _ in msgs if conv_id}
        chan_map = dict(
            db.query(Conversation.id, Conversation.source).filter(Conversation.id.in_(conv_ids))
        ) if conv_ids else {}
        for mid, content, conv_id, created in msgs:
            msg_map[mid] = {
                "kind": "chat",
                "message_id": mid,
                "conversation_id": conv_id,
                "channel": chan_map.get(conv_id),
                "preview": (content or "")[:180],
                "created_at": created.isoformat() if created else None,
            }

    note_map: dict[int, dict] = {}
    if note_ids:
        for nid, title in db.query(Note.id, Note.title).filter(Note.id.in_(note_ids)):
            note_map[nid] = {"kind": "note", "note_id": nid, "preview": title or "(untitled note)"}

    for row, m in zip(serialized, rows):
        row["source"] = msg_map.get(m.source_message_id) or note_map.get(m.source_note_id)


@router.get("/memories/stats")
def memory_stats(db: Session = Depends(get_db)):
    """Counts per type for the dashboard header tabs."""
    from ..db.models import Memory
    from sqlalchemy import func as sqlfunc
    rows = (
        db.query(Memory.type, sqlfunc.count(Memory.id))
        .filter(Memory.is_active == True)  # noqa: E712
        .group_by(Memory.type)
        .all()
    )
    return {
        "total": sum(c for _, c in rows),
        "by_type": {t: c for t, c in rows},
    }


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: int, db: Session = Depends(get_db)):
    """Soft-delete (is_active=False). Same as MCP forget."""
    if not memory_service.delete(memory_id, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@router.patch("/memories/{memory_id}")
def edit_memory(memory_id: int, body: dict, db: Session = Depends(get_db)):
    """Update content (supersede chain, preserves audit history) and/or
    type. Type change is in-place — no new row — since type taxonomy
    shifts are a metadata correction rather than a content change.
    Pass `content` to update text, `type` to change taxonomy, or both.
    """
    from ..db.models import Memory
    content = (body.get("content") or "").strip()
    new_type = (body.get("type") or "").strip().lower() or None
    if not content and not new_type:
        raise HTTPException(status_code=400, detail="content or type is required")
    if content:
        if not memory_service.update_memory(memory_id, content, db=db):
            raise HTTPException(status_code=404, detail="memory not found")
    if new_type:
        from ..services.memory_extraction import VALID_TYPES
        # `preference` is no longer in VALID_TYPES (extraction was disabled
        # there), but we still need to accept it as a target type for
        # legacy rows. Add it back to the allowed set just for this PATCH.
        allowed = VALID_TYPES | {"preference"}
        if new_type not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"type must be one of {sorted(allowed)}",
            )
        row = db.query(Memory).filter(Memory.id == memory_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="memory not found")
        row.type = new_type
        db.commit()
    return {"ok": True, "id": memory_id}
