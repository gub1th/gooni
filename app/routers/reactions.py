
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Reaction,
)

from ..serializers import (
    _REACTION_MAX_EMOJI_LEN, _REACTION_MAX_REACTOR_LEN, _validate_reaction_target, _serialize_reactions
)


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
