"""Soft-promise routing — wraps `promise_service.create` and composes the
serialized Promise rows the orchestrator's ack helper needs.

Note-save path doesn't have a source_message_id, so promises are skipped
there (notes aren't first-person utterances anyway). Only chat surfaces
emit promise routing.
"""

from __future__ import annotations


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return
    if ctx.source_message_id is None:
        return  # promises need a source utterance

    from .. import promise_service

    for sp in items:
        utterance = (sp.get("utterance") or "").strip()
        if not utterance:
            continue
        time_hint = sp.get("time_hint") or ""

        # Compose utterance + time_hint so the regex parser in
        # promise_service has a fighting chance at the deadline anchor.
        utter_for_parse = utterance
        if time_hint and time_hint not in utter_for_parse.lower():
            utter_for_parse = f"{utterance} {time_hint}"

        try:
            inferred = promise_service._infer_due_from_text(utter_for_parse)
        except Exception:
            inferred = None

        try:
            p = promise_service.create(
                ctx.db,
                utterance=utterance,
                summary=sp.get("summary"),
                source_message_id=ctx.source_message_id,
                inferred_due=inferred,
            )
        except Exception as e:
            print(f"[promises handler] create error: {e}")
            continue

        result.captured_promises.append(promise_service.serialize(p))
        result.tools_used.append("router:promise")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:promise",
                    label="Captured promise",
                    args={
                        "utterance": utterance,
                        "time_hint": time_hint or None,
                        "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
                        "slip_count": p.slip_count,
                    },
                )
            except Exception as e:
                print(f"[promises handler] trace hook error: {e}")
