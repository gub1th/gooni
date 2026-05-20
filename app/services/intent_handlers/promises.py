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

        # G3 Promise→Todo spawn: when extract_signals marks the promise as
        # action-shaped (`spawns_todo: True`, e.g. "imma text david tonight"),
        # auto-create a linked Todo + `spawned_from` edge from the Promise.
        # Chronic-style promises ("no smoke 7d") don't spawn — they stay
        # behind-the-scenes accountability surfaces. The todo text mirrors
        # the promise summary (or trimmed utterance) so it's actionable
        # on its own.
        if sp.get("spawns_todo"):
            todo_text = (sp.get("summary") or utterance).strip()[:200]
            if todo_text:
                try:
                    from .. import todo_service, edge_service
                    spawned = todo_service.todo_service.create(
                        ctx.db,
                        text=todo_text,
                        due_date=inferred,
                    )
                    edge_service.link(
                        ctx.db,
                        src_kind="promise",
                        src_id=p.id,
                        dst_kind="todo",
                        dst_id=spawned.id,
                        kind="spawned_from",
                    )
                    result.captured_todos.append({
                        "id": spawned.id,
                        "text": spawned.text,
                        "spawned_from_promise_id": p.id,
                        "mention_count": spawned.mention_count,
                    })
                    result.tools_used.append("router:todo_spawned_from_promise")
                except Exception as e:
                    print(f"[promises handler] todo spawn error: {e}")
