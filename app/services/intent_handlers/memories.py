"""Memory candidate routing.

Phase 2 lite: wraps `memory_service.apply_memory_candidates` which still
owns the reconcile dance (cosine + key search → LLM reconcile decision →
ADD/UPDATE/DELETE/NONE apply). Phase 3 will extract that loop into this
handler so memory_service becomes a thin CRUD layer.
"""

from __future__ import annotations


def handle(candidates: list[dict], ctx, result) -> None:
    if not candidates:
        return
    from ..memory_service import memory_service

    try:
        written = memory_service.apply_memory_candidates(
            candidates,
            db=ctx.db,
            source_note_id=ctx.source_note_id,
        )
    except Exception as e:
        print(f"[memories handler] apply error: {e}")
        return

    result.memories_written.extend(written)
    if written:
        result.tools_used.append("router:memory")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:memory",
                    label=f"Routed {len(written)} memory candidate(s)",
                    args={"count": len(written)},
                )
            except Exception as e:
                print(f"[memories handler] trace hook error: {e}")
