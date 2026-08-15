"""Unified promise routing — ambient-loop v2 (Slices 1 + 3).

Handles the single `promises` emit from extract_signals. Three kinds:

  create   → GLOW, not a row (Slice 3 log-first capture): the parsed
             draft lands on the source Message as has_actionable_signal +
             signal_preview; Daniel promotes or dismisses from the log's
             gutter dot. No auto-created Promise, no dispatch fork.
  complete → find_active_match → transition kept   (acts on an EXISTING
             row — closure friction should stay zero, so these remain
             automatic, but only on a CONFIDENT match: see
             promise_service.CLOSE_MATCH_THRESHOLD. Anything short of
             that lands in failed_promise_actions as a question, never
             as a flipped lifecycle — there is no undo path in the UI,
             so a wrong auto-close is a silent lie in the record.)
  break    → find_active_match → transition broken

Note-save path doesn't have a source_message_id, so promises are skipped
there (per PRD: notes rest as notes). Only chat surfaces emit promise
routing.
"""

from __future__ import annotations

import json


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return
    if ctx.source_message_id is None:
        return  # promises need a source utterance

    from .. import promise_service

    glow_signals: list[dict] = []
    for sp in items:
        kind = sp.get("kind") or "create"
        try:
            if kind == "create":
                if (sp.get("utterance") or "").strip():
                    glow_signals.append(sp)
            elif kind in ("complete", "break"):
                _handle_transition(sp, kind, ctx, result, promise_service)
        except Exception as e:
            print(f"[promises handler] {kind} error: {e}")

    if glow_signals:
        try:
            _stamp_glow(ctx, result, glow_signals)
        except Exception as e:
            print(f"[promises handler] glow stamp error: {e}")


def _stamp_glow(ctx, result, signals: list[dict]) -> None:
    """Annotate the source Message with the parsed drafts. The log view
    renders the dot; POST /messages/{id}/promote runs the real create."""
    from ...db.models import Message

    msg = (
        ctx.db.query(Message)
        .filter(Message.id == ctx.source_message_id)
        .first()
    )
    if msg is None:
        return
    msg.has_actionable_signal = True
    msg.signal_preview = json.dumps({
        "signals": signals,
        "status": "pending",
        "promise_ids": [],
    })
    ctx.db.commit()

    result.noticed_promises.extend(signals)
    result.tools_used.append("router:promise_glow")
    if ctx.on_tool_call:
        try:
            ctx.on_tool_call(
                "router:promise_glow",
                label="Commitment noticed (glow)",
                args={
                    "count": len(signals),
                    "summaries": [
                        (s.get("summary") or s.get("utterance") or "")[:80]
                        for s in signals[:3]
                    ],
                },
            )
        except Exception as e:
            print(f"[promises handler] trace hook error: {e}")


def _handle_transition(sp: dict, kind: str, ctx, result, promise_service) -> None:
    match = (sp.get("match") or "").strip()
    if not match:
        return

    target_state = "kept" if kind == "complete" else "broken"
    p, ambiguous = promise_service.find_active_match(ctx.db, match)

    if p is None:
        result.failed_promise_actions.append({
            "kind": kind,
            "match": match,
            # 2 candidates = "which one?"; 1 (near_miss) = "did you mean?";
            # empty = an honest no-match.
            "candidates": ambiguous,
        })
        return

    p = promise_service.transition(ctx.db, p.id, target_state)
    if p is None:
        return
    entry = promise_service.serialize(p)
    if target_state == "kept":
        result.completed_promises.append(entry)
    else:
        result.broken_promises.append(entry)
    result.tools_used.append(f"router:promise_{kind}")
    if ctx.on_tool_call:
        try:
            ctx.on_tool_call(
                f"router:promise_{kind}",
                label=f"Promise {target_state}",
                args={"match": match, "promise_id": p.id},
            )
        except Exception as e:
            print(f"[promises handler] trace hook error: {e}")
