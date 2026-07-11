"""Feature-request routing — wraps `feature_request_tool.execute` which
creates a `feature-request`-tagged Note (BacklogTicket died in the v2 nuke).
"""

from __future__ import annotations


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return
    from ...tools.feature_request_tool import feature_request_tool

    for fr in items:
        title = (fr.get("title") or "").strip()
        why = (fr.get("why") or "").strip()
        if not title:
            continue
        try:
            # Direct call bypasses the LLM client's _execute_with_audit, so
            # we receive the raw structured dict (not the json-serialized
            # string the LLM sees). Phase 2: read the ticket id off the dict
            # instead of regex-scraping a prose result string.
            tool_result = feature_request_tool.execute(
                db=ctx.db,
                title=title,
                why=why or None,
                source_note_id=ctx.source_note_id,
            )
        except Exception as e:
            print(f"[features handler] execute error: {e}")
            continue
        ticket_id = None
        if isinstance(tool_result, dict):
            tid = tool_result.get("id")
            ticket_id = int(tid) if tid else None
        result.captured_features.append({"title": title, "ticket_id": ticket_id})
        result.tools_used.append("router:feature_request")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:feature_request",
                    label="Logged feature request",
                    args={"title": title, "why": why},
                )
            except Exception as e:
                print(f"[features handler] trace hook error: {e}")
