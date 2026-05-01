"""eval_service — segments conversations for the eval loop and dispatches
finished evals to the Claude Code surface (note + backlog item).

Web conversations are gap-bounded upstream by find_or_create_session, so each
gets exactly one segment. Bot sources (telegram/whatsapp/imessage) reuse a
single persistent conversation, so we slice them on demand by message gap
(> EVAL_GAP_HOURS, default 4) and cache the result in the eval_segments table.

Re-segmentation triggers when message_count for a conversation exceeds the
sum of message_counts across its existing cached segments — i.e. new messages
arrived since we last segmented.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import (
    Conversation,
    EvalSegment,
    EvalStepFeedback,
    Message,
    Note,
)
from .list_service import list_service


EVAL_GAP_HOURS = float(os.getenv("EVAL_GAP_HOURS", "4"))
# Bot conversations can balloon — guard against rebuilding 10k+ message
# segments on every grid hit. Eval grid only ever needs the most recent slices.
MAX_SEGMENTS_PER_CONVERSATION = 200


# ── Segmentation ─────────────────────────────────────────────────────────────


def _ensure_segments_for_conversation(conv: Conversation, db: Session) -> list[EvalSegment]:
    """Return cached segments for a conversation, rebuilding from messages if
    new messages arrived since the last computation. Caller must commit; we
    only stage."""
    msgs: list[Message] = (
        db.query(Message)
        .filter(Message.conversation_id == conv.id)
        .order_by(Message.created_at.asc())
        .all()
    )
    if not msgs:
        return []

    cached = (
        db.query(EvalSegment)
        .filter(EvalSegment.conversation_id == conv.id)
        .order_by(EvalSegment.last_message_at.asc())
        .all()
    )
    cached_total = sum(s.message_count for s in cached)
    if cached and cached_total == len(msgs):
        return cached

    # Rebuild. Drop stale segments + their feedback.
    for s in cached:
        db.query(EvalStepFeedback).filter(EvalStepFeedback.segment_id == s.id).delete(
            synchronize_session=False
        )
        db.delete(s)
    db.flush()

    # Web sources are already 1 conv = 1 segment because find_or_create_session
    # gap-bounds them upstream. Skip the per-message gap walk.
    if conv.source == "web":
        windows = [(msgs[0], msgs[-1], msgs)]
    else:
        windows = list(_walk_gap_windows(msgs, EVAL_GAP_HOURS))

    # Cap to most recent N to avoid unbounded growth on long-running bot threads.
    if len(windows) > MAX_SEGMENTS_PER_CONVERSATION:
        windows = windows[-MAX_SEGMENTS_PER_CONVERSATION:]

    new_segments: list[EvalSegment] = []
    for start_msg, end_msg, group in windows:
        seg = EvalSegment(
            conversation_id=conv.id,
            start_message_id=start_msg.id,
            end_message_id=end_msg.id,
            last_message_at=end_msg.created_at,
            message_count=len(group),
            eval_status="not_yet",
            computed_at=datetime.now(timezone.utc),
        )
        db.add(seg)
        new_segments.append(seg)
    db.flush()
    return new_segments


def _walk_gap_windows(
    msgs: list[Message], gap_hours: float
) -> Iterable[tuple[Message, Message, list[Message]]]:
    """Yield (start, end, messages) tuples splitting wherever the gap between
    consecutive messages exceeds `gap_hours`."""
    if not msgs:
        return
    gap = timedelta(hours=gap_hours)
    current: list[Message] = [msgs[0]]
    for prev, curr in zip(msgs, msgs[1:]):
        prev_t = prev.created_at
        curr_t = curr.created_at
        if prev_t and curr_t and (curr_t - prev_t) > gap:
            yield current[0], current[-1], current
            current = [curr]
        else:
            current.append(curr)
    yield current[0], current[-1], current


# ── List + serialize ─────────────────────────────────────────────────────────


def _serialize_segment(seg: EvalSegment, conv: Conversation, preview: str | None) -> dict:
    return {
        "id": seg.id,
        "conversation_id": seg.conversation_id,
        "source": conv.source,
        "title": conv.title,
        "start_message_id": seg.start_message_id,
        "end_message_id": seg.end_message_id,
        "last_message_at": seg.last_message_at.isoformat() if seg.last_message_at else None,
        "message_count": seg.message_count,
        "eval_status": seg.eval_status,
        "overall_rating": seg.overall_rating,
        "overall_comment": seg.overall_comment,
        "dispatched_to_cc_at": (
            seg.dispatched_to_cc_at.isoformat() if seg.dispatched_to_cc_at else None
        ),
        "dispatched_note_id": seg.dispatched_note_id,
        "preview": preview,
    }


def list_segments(
    db: Session,
    *,
    sources: list[str] | None = None,
    statuses: list[str] | None = None,
    has_flag_only: bool = False,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Compute or refresh segments across all conversations matching the
    requested sources, then return the most recent slice. Sort: last_message_at DESC.
    """
    convs_q = db.query(Conversation)
    if sources:
        convs_q = convs_q.filter(Conversation.source.in_(sources))
    convs = convs_q.all()

    for conv in convs:
        _ensure_segments_for_conversation(conv, db)
    db.commit()

    seg_q = (
        db.query(EvalSegment, Conversation)
        .join(Conversation, EvalSegment.conversation_id == Conversation.id)
    )
    if sources:
        seg_q = seg_q.filter(Conversation.source.in_(sources))
    if statuses:
        seg_q = seg_q.filter(EvalSegment.eval_status.in_(statuses))
    if has_flag_only:
        flagged = (
            db.query(EvalStepFeedback.segment_id)
            .group_by(EvalStepFeedback.segment_id)
            .subquery()
        )
        seg_q = seg_q.filter(EvalSegment.id.in_(flagged))

    seg_q = seg_q.order_by(EvalSegment.last_message_at.desc())
    total = seg_q.count()
    rows = seg_q.offset(offset).limit(limit).all()

    # For each segment surface a short preview = the last user message in the window.
    segments_out: list[dict] = []
    flag_counts = _flag_counts_by_segment(db, [seg.id for seg, _ in rows])
    for seg, conv in rows:
        last_user = (
            db.query(Message)
            .filter(
                Message.conversation_id == conv.id,
                Message.id <= seg.end_message_id,
                Message.id >= seg.start_message_id,
                Message.role == "user",
            )
            .order_by(Message.created_at.desc())
            .first()
        )
        preview = (last_user.content[:200] if last_user and last_user.content else None)
        if search:
            haystack = " ".join(filter(None, [
                preview or "",
                conv.title or "",
                seg.overall_comment or "",
            ])).lower()
            if search.lower() not in haystack:
                continue
        item = _serialize_segment(seg, conv, preview)
        item["flag_count"] = flag_counts.get(seg.id, 0)
        segments_out.append(item)
    return {"segments": segments_out, "total": total}


def _flag_counts_by_segment(db: Session, segment_ids: list[int]) -> dict[int, int]:
    if not segment_ids:
        return {}
    rows = (
        db.query(EvalStepFeedback.segment_id, func.count(EvalStepFeedback.id))
        .filter(EvalStepFeedback.segment_id.in_(segment_ids))
        .group_by(EvalStepFeedback.segment_id)
        .all()
    )
    return {sid: cnt for sid, cnt in rows}


# ── Detail view ──────────────────────────────────────────────────────────────


def get_segment_full(db: Session, segment_id: int) -> dict | None:
    seg = db.query(EvalSegment).filter(EvalSegment.id == segment_id).first()
    if not seg:
        return None
    conv = db.query(Conversation).filter(Conversation.id == seg.conversation_id).first()
    if not conv:
        return None
    msgs = (
        db.query(Message)
        .filter(
            Message.conversation_id == conv.id,
            Message.id >= seg.start_message_id,
            Message.id <= seg.end_message_id,
        )
        .order_by(Message.created_at.asc())
        .all()
    )
    feedbacks_by_msg = _feedbacks_by_message(db, segment_id, [m.id for m in msgs])
    return {
        "segment": _serialize_segment(seg, conv, None),
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "is_feedback": bool(m.is_feedback),
                "feedback_for_message_id": m.feedback_for_message_id,
                "trace": _decode_trace(m.trace),
                "step_feedback": feedbacks_by_msg.get(m.id, []),
            }
            for m in msgs
        ],
    }


def _decode_trace(raw: str | None) -> list[dict] | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None


def _feedbacks_by_message(
    db: Session, segment_id: int, message_ids: list[int]
) -> dict[int, list[dict]]:
    if not message_ids:
        return {}
    rows = (
        db.query(EvalStepFeedback)
        .filter(
            EvalStepFeedback.segment_id == segment_id,
            EvalStepFeedback.message_id.in_(message_ids),
        )
        .order_by(EvalStepFeedback.created_at.asc())
        .all()
    )
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r.message_id, []).append({
            "id": r.id,
            "step_key": r.step_key,
            "step_index": r.step_index,
            "rating": r.rating,
            "comment": r.comment,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return out


# ── Feedback CRUD ────────────────────────────────────────────────────────────


def upsert_feedback(
    db: Session,
    *,
    segment_id: int,
    message_id: int,
    step_key: str,
    step_index: int,
    rating: int,
    comment: str | None,
) -> EvalStepFeedback:
    if rating not in (1, 2, 3):
        raise ValueError("rating must be 1, 2, or 3")
    existing = (
        db.query(EvalStepFeedback)
        .filter(
            EvalStepFeedback.message_id == message_id,
            EvalStepFeedback.step_key == step_key,
            EvalStepFeedback.step_index == step_index,
        )
        .first()
    )
    if existing:
        existing.rating = rating
        existing.comment = comment
        existing.segment_id = segment_id
        db.commit()
        db.refresh(existing)
        # Bump segment status to pending if reviewer just touched a step.
        _bump_segment_pending(db, segment_id)
        return existing
    fb = EvalStepFeedback(
        segment_id=segment_id,
        message_id=message_id,
        step_key=step_key,
        step_index=step_index,
        rating=rating,
        comment=comment,
    )
    db.add(fb)
    db.commit()
    db.refresh(fb)
    _bump_segment_pending(db, segment_id)
    return fb


def delete_feedback(db: Session, feedback_id: int) -> bool:
    fb = db.query(EvalStepFeedback).filter(EvalStepFeedback.id == feedback_id).first()
    if not fb:
        return False
    db.delete(fb)
    db.commit()
    return True


def _bump_segment_pending(db: Session, segment_id: int) -> None:
    seg = db.query(EvalSegment).filter(EvalSegment.id == segment_id).first()
    if seg and seg.eval_status == "not_yet":
        seg.eval_status = "pending"
        db.commit()


# ── Summary update ───────────────────────────────────────────────────────────


def update_summary(
    db: Session,
    segment_id: int,
    *,
    eval_status: str | None = None,
    overall_rating: int | None = None,
    overall_comment: str | None = None,
) -> EvalSegment | None:
    seg = db.query(EvalSegment).filter(EvalSegment.id == segment_id).first()
    if not seg:
        return None
    if eval_status is not None:
        if eval_status not in ("not_yet", "pending", "done"):
            raise ValueError("eval_status must be not_yet|pending|done")
        seg.eval_status = eval_status
    if overall_rating is not None:
        if overall_rating not in (1, 2, 3):
            raise ValueError("overall_rating must be 1, 2, or 3")
        seg.overall_rating = overall_rating
    if overall_comment is not None:
        seg.overall_comment = overall_comment
    db.commit()
    db.refresh(seg)
    return seg


# ── Dispatch to Claude Code ──────────────────────────────────────────────────


def dispatch_to_cc(db: Session, segment_id: int) -> dict:
    """Bundle the eval (transcript + traces + flags + summary) into a note in
    the 'Claude Code' space + a backlog item linking back. Marks the segment
    dispatched. Idempotent on re-dispatch — overwrites the previous note's
    content rather than spawning duplicates.
    """
    full = get_segment_full(db, segment_id)
    if not full:
        raise ValueError(f"segment {segment_id} not found")
    seg = db.query(EvalSegment).filter(EvalSegment.id == segment_id).first()
    if not seg:
        raise ValueError(f"segment {segment_id} not found")

    body = _format_dispatch_body(full)
    title = _format_dispatch_title(full)
    space = _get_or_create_claude_code_space(db)
    note: Note
    if seg.dispatched_note_id:
        note = db.query(Note).filter(Note.id == seg.dispatched_note_id).first()
    else:
        note = None
    if note is None:
        note = Note(
            title=title,
            content=body,
            space_id=space.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(note)
        db.flush()
    else:
        note.title = title
        note.content = body
        note.updated_at = datetime.utcnow()

    backlog = list_service.get_or_create_list("Backlog", "backlog", emoji=None, db=db)
    one_liner = (
        f"Eval segment #{seg.id} ({full['segment'].get('source')}): "
        f"{full['segment'].get('overall_comment') or full['segment'].get('preview') or 'review needed'}"
    )[:240]
    list_service.add_item(
        backlog.id,
        one_liner,
        db,
        subtitle=f"See note #{note.id}",
        source_note_id=note.id,
    )

    seg.dispatched_to_cc_at = datetime.now(timezone.utc)
    seg.dispatched_note_id = note.id
    db.commit()
    db.refresh(seg)

    return {
        "ok": True,
        "note_id": note.id,
        "backlog_list_id": backlog.id,
        "dispatched_to_cc_at": seg.dispatched_to_cc_at.isoformat() if seg.dispatched_to_cc_at else None,
    }


def _format_dispatch_title(full: dict) -> str:
    seg = full["segment"]
    src = seg.get("source") or "web"
    when = seg.get("last_message_at") or ""
    return f"Eval [{src}] {when[:10]} — segment #{seg['id']}"


def _format_dispatch_body(full: dict) -> str:
    """HTML body for the Gooni note. Sections: header, summary, transcript +
    inline trace + flags. Designed to be readable in the notes editor and
    parseable by future MCP-side scripts."""
    seg = full["segment"]
    lines: list[str] = []
    lines.append(f"<h2>Eval — segment #{seg['id']}</h2>")
    lines.append(
        f"<p><strong>Source:</strong> {seg.get('source')} · "
        f"<strong>Status:</strong> {seg.get('eval_status')} · "
        f"<strong>Overall rating:</strong> {seg.get('overall_rating') or '—'} · "
        f"<strong>Messages:</strong> {seg.get('message_count')}</p>"
    )
    if seg.get("overall_comment"):
        lines.append(f"<h3>Reviewer summary</h3><blockquote>{_escape(seg['overall_comment'])}</blockquote>")

    lines.append("<h3>Transcript + trace + flags</h3>")
    for m in full["messages"]:
        role = (m["role"] or "").upper()
        lines.append(f"<h4>[{role}] msg #{m['id']}</h4>")
        lines.append(f"<p>{_escape((m['content'] or '')[:1500])}</p>")
        if m["role"] == "assistant" and m.get("trace"):
            lines.append("<details><summary>Trace</summary><ul>")
            for step in m["trace"]:
                key = step.get("key") or step.get("type") or "?"
                label = step.get("label") or ""
                lines.append(f"<li><strong>{key}</strong> — {_escape(label)}</li>")
            lines.append("</ul></details>")
        if m.get("step_feedback"):
            lines.append("<ul>")
            for fb in m["step_feedback"]:
                rating_emoji = {1: "👎", 2: "😐", 3: "👍"}.get(fb["rating"], "?")
                lines.append(
                    f"<li>🚩 <strong>{fb['step_key']}</strong> "
                    f"{rating_emoji} — {_escape(fb.get('comment') or '')}</li>"
                )
            lines.append("</ul>")
    lines.append(
        "<p><em>Auto-dispatched from Gooni eval loop. Ratings tied to "
        "pipeline_version stamped in the trace.</em></p>"
    )
    return "\n".join(lines)


def _escape(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _get_or_create_claude_code_space(db: Session):
    """Mirror of the MCP server's _resolve_space_id. Lookup by name; create if
    missing so dispatch never silently fails on a fresh DB."""
    from ..db.models import Space

    space = (
        db.query(Space)
        .filter(func.lower(Space.name) == "claude code")
        .first()
    )
    if space:
        return space
    space = Space(name="Claude Code", emoji="🤖")
    db.add(space)
    db.commit()
    db.refresh(space)
    return space


# ── Tool legend (static) ─────────────────────────────────────────────────────


TOOL_LEGEND: list[dict] = [
    {
        "key": "router:tone",
        "name": "Tone correction capture",
        "description": (
            "Triggered when extract_signals classifies the user's message as a tone "
            "correction (e.g. 'less teacher-y'). Stores a preference-type memory so "
            "the rule applies to every future reply across all surfaces."
        ),
    },
    {
        "key": "router:feature_request",
        "name": "Feature request log",
        "description": (
            "Triggered when extract_signals classifies the user's message as a "
            "feature request. Calls feature_request_tool to log a structured "
            "request for later triage."
        ),
    },
    {
        "key": "undo_feedback",
        "name": "Undo last feedback",
        "description": (
            "Triggered by the explicit undo regex (e.g. 'undo last feedback'). "
            "Deactivates the most recent feedback-derived preference memory."
        ),
    },
    {
        "key": "memory_recall",
        "name": "Memory retrieval",
        "description": (
            "Cosine-similarity search over fact / goal / routine / constraint / "
            "episode memories using the user's query. Always-include preferences "
            "are added separately. Top-K configurable via RETRIEVAL_TOP_K."
        ),
    },
    {
        "key": "intention",
        "name": "Intent inference",
        "description": (
            "LLM call to summarize Daniel's current intent given the latest "
            "message + last 6 messages. Result is injected into the master prompt "
            "so the reply LLM knows what Daniel is trying to do."
        ),
    },
    {
        "key": "extracted_signals",
        "name": "Unified signal extraction",
        "description": (
            "Single LLM call returning {tone_corrections, feature_requests, "
            "memory_candidates}. Replaces three separate prompts the previous "
            "pipeline used."
        ),
    },
    {
        "key": "memories_applied",
        "name": "Memory reconcile outcome",
        "description": (
            "Result of running extracted memory candidates through the reconcile "
            "LLM (ADD/UPDATE/DELETE/NONE). Runs off-thread so the reply isn't "
            "blocked — may be empty if the trace was captured before reconcile "
            "finished."
        ),
    },
    {
        "key": "master_prompt",
        "name": "Assembled system prompt",
        "description": (
            "Full system-prompt string handed to the reply LLM, plus a preview "
            "of the recent-history window. Use this to spot prompt-bloat or "
            "missing context blocks."
        ),
    },
    {
        "key": "reply",
        "name": "Reply generation",
        "description": (
            "The response LLM call. Captures the assistant text plus token "
            "usage and total turn latency."
        ),
    },
]
