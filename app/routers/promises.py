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


@router.get("/promises")
def list_promises(
    state: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List promises. Default returns the most recent N regardless of state
    so the dashboard drawer can show history alongside active commitments.
    Pass `state=proposed|pending|kept|broken|abandoned` for one slate.
    """
    from ..db.models import Promise as _Promise

    q = db.query(_Promise)
    # Modern 5-state lifecycle (matches frontend PromiseState type +
    # api.ts schema). The legacy "active" alias was renamed to "pending"
    # during the proposed-vs-pending lock-in split; this validation list
    # was stale and 400'd the dashboard PromiseDrawer fetch on "pending".
    _VALID_STATES = ("proposed", "pending", "kept", "broken", "abandoned")
    if state:
        if state not in _VALID_STATES:
            raise HTTPException(
                status_code=400,
                detail=f"invalid state (expected one of {_VALID_STATES})",
            )
        q = q.filter(_Promise.state == state)
    # Pending sorts deadline-first so the closest-due promise bubbles up;
    # everything else sorts by recency.
    if state == "pending":
        q = q.order_by(
            _Promise.inferred_due.asc().nullslast(), _Promise.created_at.desc()
        )
    else:
        q = q.order_by(_Promise.created_at.desc())
    rows = q.limit(limit).all()
    return [_serialize_promise(p) for p in rows]


@router.get("/promises/pis")
def promise_integrity_score(db: Session = Depends(get_db)):
    """Promise Integrity Score — Daniel's accountability scoreboard.

    G3.1 weighting (3-state lifecycle):
      kept   → +1.0
      broken → -1.5  (asymmetric: breaking stings more than keeping helps)
      active → 0     (not counted; resolution unknown yet)

    Normalized to 0..100 percentage. Plus current kept-streak (consecutive
    `kept` walking back from most recent) and last_broken metadata.

    Returns `{score: null, ...}` when fewer than 3 resolved promises exist
    — small-N noise distorts the score, better to show "not enough data".

    Algorithm notes:
      score% = ((sum + theoretical_min_abs) / theoretical_range) * 100
      Pre-G3.1 `abandoned` rolled into `broken` during the state collapse
      migration; the score function lost its softer-penalty middle ground.
      If a softer 'gave up gracefully' verdict comes back, add a state +
      re-introduce the asymmetric weight here.
    """
    from ..db.models import Promise as _Promise

    RESOLVED = ("kept", "broken")
    WEIGHTS = {"kept": 1.0, "broken": -1.5}
    MIN_SAMPLE = 3
    WINDOW = 20

    rows = (
        db.query(_Promise)
        .filter(_Promise.state.in_(RESOLVED))
        .order_by(_Promise.resolved_at.desc().nullslast(), _Promise.id.desc())
        .limit(WINDOW)
        .all()
    )
    sample_size = len(rows)

    if sample_size < MIN_SAMPLE:
        return {
            "score": None,
            "sample_size": sample_size,
            "min_sample": MIN_SAMPLE,
            "kept_streak": 0,
            "last_broken_at": None,
            "last_broken_summary": None,
            "weights": WEIGHTS,
            "window": WINDOW,
            "note": "need at least 3 resolved promises to compute",
        }

    total = sum(WEIGHTS[r.state] for r in rows)
    # Theoretical range across the sample window.
    theoretical_max = sample_size * 1.0          # all kept
    theoretical_min = sample_size * -1.5         # all broken
    range_ = theoretical_max - theoretical_min   # = sample_size * 2.5
    pct = int(round(((total - theoretical_min) / range_) * 100))
    pct = max(0, min(100, pct))

    # Kept streak — walk recent-first until we hit a non-kept.
    streak = 0
    for r in rows:
        if r.state == "kept":
            streak += 1
        else:
            break

    last_broken = next((r for r in rows if r.state == "broken"), None)

    return {
        "score": pct,
        "sample_size": sample_size,
        "min_sample": MIN_SAMPLE,
        "kept_streak": streak,
        "last_broken_at": (
            last_broken.resolved_at.isoformat() if last_broken and last_broken.resolved_at else None
        ),
        "last_broken_summary": (
            (last_broken.summary or last_broken.utterance)
            if last_broken else None
        ),
        "weights": WEIGHTS,
        "window": WINDOW,
    }


@router.patch("/promises/{promise_id}")
def patch_promise(promise_id: int, body: dict, db: Session = Depends(get_db)):
    """G3.1 state transition only — active | kept | broken. Mirrors
    `promise_service.transition` so the same idempotency + resolved_at
    bookkeeping fires regardless of caller. Lock-in is gone — habit
    auto-spawn now fires at promise create (see promise_service.create).
    """
    from ..services import promise_service

    new_state = body.get("state")
    if new_state not in ("active", "kept", "broken"):
        raise HTTPException(status_code=400, detail="state required (active|kept|broken)")
    p = promise_service.transition(db, promise_id, new_state)
    if p is None:
        raise HTTPException(status_code=404, detail="Promise not found")
    return _serialize_promise(p)
