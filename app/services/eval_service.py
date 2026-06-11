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
    EvalMessageRating,
    EvalSegment,
    EvalStepFeedback,
    Message,
    Note,
    Reflection,
    ToolCall,
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


# Recency window for the live "currently active" badge on segment cards.
# Tuned so a segment Daniel is mid-conversation in stays lit while ambient
# bot replies don't keep stale threads "active". 30 min ≈ a single phone
# session; bump if the bot replies feel like they keep tripping it.
_ACTIVE_RECENT_MINUTES = 30


def _segment_cost_usd(seg: EvalSegment, db: Session) -> float:
    """Sum the chat-call cost across all assistant messages in this segment.

    Reads per-message usage from Message.trace[step.key='reply'].meta.usage
    — that's the UsageTracker output the orchestrator stamps onto every
    reply. Returns USD float, 0.0 if no usage data found.

    Limitation: covers the main chat call only. Sub-calls (extract,
    reflect, plan, verify) aren't yet stamped on Message.trace — they
    happen in separate llm_client calls without per-message usage capture
    on the audit row. Underestimates by ~$0.001-0.002/turn.
    """
    import json as _j
    from ..llm.openai_pricing import calculate_chat_cost

    rows = (
        db.query(Message.trace)
        .filter(
            Message.conversation_id == seg.conversation_id,
            Message.id >= seg.start_message_id,
            Message.id <= seg.end_message_id,
            Message.role == "assistant",
            Message.trace.isnot(None),
        )
        .all()
    )
    total = 0.0
    for (trace_json,) in rows:
        if not trace_json:
            continue
        try:
            steps = _j.loads(trace_json)
        except (_j.JSONDecodeError, TypeError):
            continue
        for s in steps:
            if (s.get("key") or s.get("type")) != "reply":
                continue
            usage = (s.get("meta") or {}).get("usage") or {}
            model = (
                usage.get("model")
                or usage.get("pipeline_model")
                or "gpt-4o-mini"
            )
            inp = usage.get("input_tokens") or 0
            out = usage.get("output_tokens") or 0
            if inp or out:
                total += calculate_chat_cost(model, inp, out)["total_cost"]
            break  # one reply step per trace
    return round(total, 6)


def _serialize_segment(
    seg: EvalSegment,
    conv: Conversation,
    preview: str | None,
    cost_usd: float | None = None,
) -> dict:
    is_active = False
    if seg.last_message_at is not None:
        last = seg.last_message_at
        # last_message_at is stored naive UTC; compare against naive utcnow.
        if last.tzinfo is not None:
            last = last.replace(tzinfo=None)
        is_active = (datetime.utcnow() - last) < timedelta(minutes=_ACTIVE_RECENT_MINUTES)
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
        "is_active": is_active,
        "cost_usd": cost_usd,
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
        item = _serialize_segment(seg, conv, preview, cost_usd=_segment_cost_usd(seg, db))
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
    message_ids = [m.id for m in msgs]
    feedbacks_by_msg = _feedbacks_by_message(db, segment_id, message_ids)
    ratings_by_msg = _message_ratings_by_id(db, message_ids)
    tool_calls_by_msg = _tool_calls_by_message(db, message_ids)
    reflections_by_msg = _reflections_by_message(db, message_ids)
    return {
        "segment": _serialize_segment(seg, conv, None, cost_usd=_segment_cost_usd(seg, db)),
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
                "rating": ratings_by_msg.get(m.id),
                "tool_calls": tool_calls_by_msg.get(m.id, []),
                # Latest Reflexion row for this assistant turn (or None).
                # Joined here instead of N+1 fetching per message so the eval
                # drilldown and dispatched note can both render the self-take.
                "reflection": reflections_by_msg.get(m.id),
            }
            for m in msgs
        ],
    }


def _reflections_by_message(
    db: Session, message_ids: list[int]
) -> dict[int, dict]:
    if not message_ids:
        return {}
    rows = (
        db.query(Reflection)
        .filter(Reflection.message_id.in_(message_ids))
        .order_by(Reflection.created_at.desc())
        .all()
    )
    # message_id is the de-facto key — there should only ever be one
    # Reflection per assistant message, but order_by desc means if a duplicate
    # somehow exists we keep the most recent.
    out: dict[int, dict] = {}
    for r in rows:
        if r.message_id in out:
            continue
        out[r.message_id] = {
            "id": r.id,
            "severity": r.severity,
            "user_critique_present": bool(r.user_critique_present),
            "critique_summary": r.critique_summary,
            "action_vs_described": r.action_vs_described,
            "gap_exposed": r.gap_exposed,
            "proposed_self_fix": r.proposed_self_fix,
            "model": r.model,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
    return out


def _tool_calls_by_message(
    db: Session, message_ids: list[int]
) -> dict[int, list[dict]]:
    """Audit rows from `tool_calls`, grouped by message_id.

    Surfaces the ground truth of what executed: status, error, latency,
    args/result snapshots. The `Message.trace` array carries a snapshot
    too, but it's the orchestrator's pre-execution view — when chat
    hallucinates a tool name or a tool errors mid-run, the trace can
    diverge from reality. The audit rows are authoritative.
    """
    if not message_ids:
        return {}
    rows = (
        db.query(ToolCall)
        .filter(ToolCall.message_id.in_(message_ids))
        .order_by(ToolCall.started_at.asc(), ToolCall.id.asc())
        .all()
    )
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r.message_id, []).append({
            "id": r.id,
            "tool_name": r.tool_name,
            "status": r.status,
            "args_json": r.args_json,
            "result_json": r.result_json,
            "error": r.error,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "duration_ms": (
                int((r.finished_at - r.started_at).total_seconds() * 1000)
                if r.finished_at and r.started_at
                else None
            ),
        })
    return out


def _decode_trace(raw: str | None) -> list[dict] | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None


def _message_ratings_by_id(
    db: Session, message_ids: list[int]
) -> dict[int, dict]:
    """Lookup of per-message thumbs ratings keyed by message_id."""
    if not message_ids:
        return {}
    rows = (
        db.query(EvalMessageRating)
        .filter(EvalMessageRating.message_id.in_(message_ids))
        .all()
    )
    return {
        r.message_id: {
            "id": r.id,
            "rating": r.rating,
            "comment": r.comment,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    }


def upsert_message_rating(
    db: Session,
    *,
    segment_id: int,
    message_id: int,
    rating: int | None,
    comment: str | None,
) -> EvalMessageRating:
    """Insert or update the single rating row for an assistant message.
    Validates message belongs to the segment so a stray PUT can't pin a
    rating onto an unrelated thread.

    `rating` may be NULL to support comment-only saves — the row exists
    purely to anchor the reviewer's note. Empty rows (no rating + no
    comment) are rejected.
    """
    if rating is not None and rating not in (1, 2, 3):
        raise ValueError("rating must be 1, 2, or 3 (or null)")
    if rating is None and not (comment or "").strip():
        raise ValueError("at least a rating or a comment is required")
    seg = db.query(EvalSegment).filter(EvalSegment.id == segment_id).first()
    if not seg:
        raise ValueError(f"segment {segment_id} not found")
    msg = db.query(Message).filter(Message.id == message_id).first()
    if not msg:
        raise ValueError(f"message {message_id} not found")
    if not (
        msg.conversation_id == seg.conversation_id
        and seg.start_message_id <= msg.id <= seg.end_message_id
    ):
        raise ValueError("message not in segment range")
    existing = (
        db.query(EvalMessageRating)
        .filter(EvalMessageRating.message_id == message_id)
        .first()
    )
    if existing is None:
        existing = EvalMessageRating(
            segment_id=segment_id,
            message_id=message_id,
            rating=rating,
            comment=comment,
        )
        db.add(existing)
    else:
        existing.rating = rating
        existing.comment = comment
        existing.segment_id = segment_id
    db.commit()
    db.refresh(existing)
    # Reviewer touched the segment → flip not_yet → pending. Mirrors what
    # `upsert_feedback` already does for step-level flags. Without this, a
    # message rated + commented stays "not_yet" until explicit Done click.
    _bump_segment_pending(db, segment_id)
    return existing


def delete_message_rating(db: Session, *, message_id: int) -> bool:
    row = (
        db.query(EvalMessageRating)
        .filter(EvalMessageRating.message_id == message_id)
        .first()
    )
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True


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


def backfill_pending_status(db: Session) -> int:
    """One-shot backfill: any segment currently `not_yet` that already has
    a reviewer touch (message rating OR step feedback) gets flipped to
    `pending`. Idempotent — re-runs are no-ops once everything is settled.

    Returns the count of segments flipped.
    """
    # Distinct segment ids that have at least one reviewer artifact.
    rating_seg_ids = {
        sid for (sid,) in db.query(EvalMessageRating.segment_id).distinct().all()
        if sid is not None
    }
    feedback_seg_ids = {
        sid for (sid,) in db.query(EvalStepFeedback.segment_id).distinct().all()
        if sid is not None
    }
    touched = rating_seg_ids | feedback_seg_ids
    if not touched:
        return 0
    rows = (
        db.query(EvalSegment)
        .filter(EvalSegment.eval_status == "not_yet")
        .filter(EvalSegment.id.in_(touched))
        .all()
    )
    for r in rows:
        r.eval_status = "pending"
    if rows:
        db.commit()
    return len(rows)


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
    # Excerpt stamped alongside content so the dispatched note shows a
    # preview in the notes-list endpoint immediately. Without this the
    # row rendered blank until the lazy backfill job ran (PR #134) and
    # made the dispatched note look empty in the sidebar.
    from app.serializers import _excerpt_from_html
    excerpt = _excerpt_from_html(body)
    note: Note
    if seg.dispatched_note_id:
        note = db.query(Note).filter(Note.id == seg.dispatched_note_id).first()
    else:
        note = None
    if note is None:
        note = Note(
            title=title,
            content=body,
            excerpt=excerpt,
            space_id=space.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(note)
        db.flush()
    else:
        note.title = title
        note.content = body
        note.excerpt = excerpt
        note.updated_at = datetime.utcnow()

    from .backlog_service import backlog_service
    one_liner = (
        f"Eval segment #{seg.id} ({full['segment'].get('source')}): "
        f"{full['segment'].get('overall_comment') or full['segment'].get('preview') or 'review needed'}"
    )[:240]
    backlog_service.create(
        db,
        text=one_liner,
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
    if not full["messages"]:
        lines.append("<p><em>(no messages in segment range)</em></p>")
    rating_emoji_map = {1: "👎 bad", 2: "➖ neutral", 3: "👍 good"}
    sev_label_map = {1: "clean", 2: "notable", 3: "load-bearing"}
    for m in full["messages"]:
        role = (m["role"] or "").upper()
        lines.append(f"<h4>[{role}] msg #{m['id']}</h4>")
        lines.append(f"<p>{_escape((m['content'] or '')[:1500])}</p>")
        # Per-message reviewer rating + comment (the thumbs row Daniel uses
        # in the eval drilldown). Previously omitted from dispatch — Daniel
        # flagged that the dispatched note was missing his per-turn evals.
        if m.get("rating"):
            rating = m["rating"]
            label = rating_emoji_map.get(rating["rating"], "?")
            comment_html = (
                f"<blockquote>{_escape(rating.get('comment') or '')}</blockquote>"
                if rating.get("comment")
                else ""
            )
            lines.append(
                f"<p><strong>Reviewer rating:</strong> {label}</p>{comment_html}"
            )
        # Gooni's self-take (Reflexion row). Surface sev ≥ 2 only so clean
        # turns don't bloat the note.
        if m.get("reflection") and (m["reflection"].get("severity") or 0) >= 2:
            ref = m["reflection"]
            sev = ref.get("severity")
            sev_label = sev_label_map.get(sev, str(sev))
            ref_lines = [
                f"<p><strong>Gooni's self-take</strong> · sev {sev} · {sev_label} "
                f"· {ref.get('action_vs_described') or ''}</p>"
            ]
            if ref.get("critique_summary"):
                ref_lines.append(f"<p><em>Daniel pushed back:</em> {_escape(ref['critique_summary'])}</p>")
            if ref.get("gap_exposed"):
                ref_lines.append(f"<p><em>Gap:</em> {_escape(ref['gap_exposed'])}</p>")
            if ref.get("proposed_self_fix"):
                ref_lines.append(f"<p><em>Proposed fix:</em> {_escape(ref['proposed_self_fix'])}</p>")
            lines.extend(ref_lines)
        # `<details><summary>` aren't in TipTap StarterKit so the editor
        # silently dropped them on render — that's why dispatched notes
        # looked half-empty. Use a plain heading + list so traces stay
        # visible (collapsing is the editor view's problem, not ours).
        if m["role"] == "assistant" and m.get("trace"):
            lines.append("<h5>Trace</h5><ul>")
            for step in m["trace"]:
                key = step.get("key") or step.get("type") or "?"
                label = step.get("label") or ""
                lines.append(f"<li><strong>{key}</strong> — {_escape(label)}</li>")
            lines.append("</ul>")
        if m.get("tool_calls"):
            lines.append("<h5>Tool calls (audit)</h5><ul>")
            for tc in m["tool_calls"]:
                status = tc.get("status") or "?"
                dur = tc.get("duration_ms")
                dur_s = f" · {dur}ms" if dur is not None else ""
                err = (
                    f" · <em>error:</em> {_escape(tc['error'] or '')}"
                    if tc.get("error")
                    else ""
                )
                lines.append(
                    f"<li><strong>{tc.get('tool_name')}</strong> "
                    f"[{status}]{dur_s}{err}</li>"
                )
            lines.append("</ul>")
        if m.get("step_feedback"):
            lines.append("<h5>Step flags</h5><ul>")
            for fb in m["step_feedback"]:
                rating_label = rating_emoji_map.get(fb["rating"], "?")
                lines.append(
                    f"<li>🚩 <strong>{fb['step_key']}</strong> "
                    f"{rating_label} — {_escape(fb.get('comment') or '')}</li>"
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
        "key": "memory_recall",
        "name": "Memory retrieval",
        "description": (
            "Cosine-similarity search over fact / goal / routine / constraint / "
            "episode memories using the user's query. Always-include preferences "
            "are added separately. Per-type top-K + floor configured in "
            "RETRIEVAL_PER_TYPE (memory_service.py)."
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
