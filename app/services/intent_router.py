"""Intent router — single dispatch point for extracted signals.

Per note #258 phase 2: the chat orchestrator and `classify_note` both
took the output of `extract_signals` and routed it to per-signal-type
services with copy-pasted logic. Two routing layers that could drift
(the "demo for gooni" bug was this drift in flight).

This module is the unified entry point. Callers pass the signals dict
(plus surface-specific context like db, source_message_id, prev_assistant)
and the router fans out to per-signal handlers in `intent_handlers/`.

Phase 2 lite: handlers wrap existing services (memory_service,
promise_service, feature_request_tool). The internal reconcile dance
stays inside memory_service for now — phase 3 will extract it.

Return shape: dict keyed by signal type, with whatever the handler chose
to surface (memory rows written, feature titles, promise serializations,
tone rules). Callers stitch this into traces / acks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session


@dataclass
class RouterContext:
    """Surface-specific stuff handlers need. Not all fields apply to all
    surfaces — chat turn has prev_assistant + source_message_id, note save
    has source_note_id, etc. Handlers pull what they need and ignore the
    rest."""

    db: Session
    source_message_id: int | None = None
    source_note_id: int | None = None
    prev_assistant_text: str | None = None
    prev_assistant_id: int | None = None
    # Trace builder hook for handlers that want to record tool_call events.
    # Optional — note-save path doesn't have a trace.
    on_tool_call: Any = None  # callable(name, label, args) | None


@dataclass
class RouterResult:
    """What the router actually did. Empty lists when a signal type had
    nothing to route."""

    memories_written: list[Any] = field(default_factory=list)
    # Each entry: {"title": str, "ticket_id": int | None}. Used by ack +
    # just_extracted blocks to surface real BacklogTicket ids — anti-
    # hallucination layer for the "tracked without id" failure mode.
    captured_features: list[dict] = field(default_factory=list)
    tone_rules: list[str] = field(default_factory=list)
    # Serialized Promise rows created this turn. Slice 3: chat-side
    # auto-create is gone (creates glow instead) — this only populates
    # from explicit creation paths (promote route re-dispatch, future
    # tools). Kept because ack/verify plumbing reads it.
    captured_promises: list[dict] = field(default_factory=list)
    # Slice 3 glow: promise-create signals NOTICED on this turn's message
    # (annotation only — NOT rows). just_extracted uses this to license
    # "i see the commitment" phrasing while forbidding "tracked" claims.
    noticed_promises: list[dict] = field(default_factory=list)
    # Ambient-loop v2: chat-side promise lifecycle results. Serialized
    # Promise rows flipped kept (kind=complete) / broken (kind=break).
    completed_promises: list[dict] = field(default_factory=list)
    broken_promises: list[dict] = field(default_factory=list)
    # complete/break emits whose match found nothing (candidates empty)
    # or was ambiguous (top-2 within 0.05 — candidates carries both so
    # the ack can ask "which one?"). Each:
    #   {"kind": "complete"|"break", "match": str, "candidates": [...]}
    failed_promise_actions: list[dict] = field(default_factory=list)
    # PR-1 fitness pipeline — DailyMetric rows logged this turn. Each entry:
    #   {"log_type": str, "metric_type": str | None, "value": float | None,
    #    "unit": str | None, "running_calories": float, "running_protein": float,
    #    "correction": bool, "exercise_label": str | None}
    # The ack composer renders the running daily total from these; the
    # short-circuit + unbacked-check treat them like captured_todos.
    captured_metrics: list[dict] = field(default_factory=list)
    # Phase 5: extractor's classification of how much reply the user
    # wants. One of "answer" | "acknowledge" | "task_only" | "no_reply".
    # Defaults to "answer" — conservative; callers gate the LLM reply
    # step on this only when they're confident the intent is task_only
    # or no_reply.
    reply_intent: str = "answer"
    tools_used: list[str] = field(default_factory=list)

    def wrote_anything(self) -> bool:
        """True if this turn produced any durable write (a captured/mutated
        primitive or a saved preference). The reflexion hallucination check
        uses this — router captures aren't ToolCall rows, so the audit alone
        can't see them. memories_written excluded: reconcile runs off-thread,
        so it isn't a reliable same-turn signal."""
        return bool(
            self.captured_features
            or self.tone_rules
            or self.captured_promises
            or self.completed_promises
            or self.broken_promises
            or self.captured_metrics
        )


def dispatch(signals: dict, ctx: RouterContext) -> RouterResult:
    """Fan out signals to per-type handlers. Each handler is wrapped so
    a single handler failure doesn't kill the rest of the routing.
    """
    from .intent_handlers import features, fitness, memories, promises, tones

    result = RouterResult()
    # Pass through reply_intent (phase 5) — extractor classifies, caller
    # uses it to gate the LLM reply step.
    intent = signals.get("reply_intent")
    if isinstance(intent, str) and intent in (
        "answer", "acknowledge", "task_only", "no_reply"
    ):
        result.reply_intent = intent

    # Order matters slightly: tone_corrections need to look at
    # prev_assistant to set feedback_for_message_id on the user message,
    # so they run first. Other handlers are order-independent.
    try:
        tones.handle(signals.get("tone_corrections") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] tone handler error: {e}")

    try:
        features.handle(signals.get("feature_requests") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] feature handler error: {e}")

    # Ambient-loop v2: ONE actionable emit. create/complete/break all
    # live on the unified `promises` signal list.
    try:
        promises.handle(signals.get("promises") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] promise handler error: {e}")

    # PR-1: fitness logs → DailyMetric rows + running-total stamp. Real-time
    # (not batched) — Daniel wants the "1,165 cal so far" ack instantly.
    try:
        fitness.handle(signals.get("fitness_logs") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] fitness handler error: {e}")

    try:
        memories.handle(signals.get("memories") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] memory handler error: {e}")

    return result
