"""Feature-request routing — wraps `feature_request_tool.execute` which
creates a BacklogTicket row.
"""

from __future__ import annotations


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return
    from ...tools.feature_request_tool import feature_request_tool

    import re as _re

    for fr in items:
        title = (fr.get("title") or "").strip()
        why = (fr.get("why") or "").strip()
        if not title:
            continue
        try:
            tool_result = feature_request_tool.execute(
                db=ctx.db,
                title=title,
                why=why or None,
                source_note_id=ctx.source_note_id,
            )
        except Exception as e:
            print(f"[features handler] execute error: {e}")
            continue
        result.feature_titles.append(title)
        # Parse "(id #N)" or "#N" out of the tool result for back-link
        # tracking — classify_note uses it to deep-link from notes.
        m = _re.search(r"#(\d+)", tool_result or "")
        ticket_id = int(m.group(1)) if m else None
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
