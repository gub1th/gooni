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
    captured_promises: list[dict] = field(default_factory=list)
    # Each entry: {"text": str, "todo_id": int}. Mirrors captured_features
    # so the ack helper can render with real Todo ids.
    captured_todos: list[dict] = field(default_factory=list)
    # G1.1 destructive todo action results — populated by router-level
    # dispatch when the extractor emits kind=delete | complete | merge.
    # Each entry mirrors captured_todos {"text", "todo_id"} except merge
    # which carries both ids. Ack composer renders these separately.
    killed_todos: list[dict] = field(default_factory=list)
    completed_todos: list[dict] = field(default_factory=list)
    # Merge entries: {"into_text", "into_id", "from_text", "from_id"}.
    merged_todos: list[dict] = field(default_factory=list)
    # Observability: destructive actions where the extractor emitted a
    # match but the router couldn't find a matching open todo. Logged to
    # the trace + surfaced in ack so Daniel can spot extraction errors.
    failed_todo_actions: list[dict] = field(default_factory=list)
    # G3.9 edit-action results — populated by router-level dispatch when
    # the extractor emits kind=edit. Each entry:
    #   {"text": str, "todo_id": int, "changes": [str], "from": dict}
    # changes = human-readable list of what changed ("due → friday",
    # "primary", "linked-parent: X"). from = pre-edit snapshot for ack.
    edited_todos: list[dict] = field(default_factory=list)
    # G3.9 implicit-done results from `done_signals` extraction. Each:
    #   {"text": str, "todo_id": int, "phrase": str}
    implicit_done_todos: list[dict] = field(default_factory=list)
    # G3.9 disambiguation queue — when cosine match returns ≥2 candidates
    # within 0.05 score gap, the handler doesn't execute. Ack composer
    # surfaces a "which one — A or B?" question; Daniel's next turn
    # picks the right one with more specific text.
    # Each entry: {"action": "delete"|"complete"|"edit"|"done_signal",
    #              "match": str, "candidates": [{"id", "text", "score"}]}
    disambiguation_needed: list[dict] = field(default_factory=list)
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


def dispatch(signals: dict, ctx: RouterContext) -> RouterResult:
    """Fan out signals to per-type handlers. Each handler is wrapped so
    a single handler failure doesn't kill the rest of the routing.
    """
    from .intent_handlers import features, fitness, memories, promises, todos, tones

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

    try:
        promises.handle(signals.get("soft_promises") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] promise handler error: {e}")

    try:
        todos.handle(signals.get("todos") or [], ctx, result)
    except Exception as e:
        print(f"[intent_router] todo handler error: {e}")

    # G3.9 implicit-done: "just called papi" auto-closes the matching todo
    # at ≥0.85 cosine. Lives on its own signal list (done_signals) so the
    # extractor can emit it independently of the explicit todos[] actions.
    try:
        todos.handle_done_signals(
            signals.get("done_signals") or [], ctx, result
        )
    except Exception as e:
        print(f"[intent_router] done_signals handler error: {e}")

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
