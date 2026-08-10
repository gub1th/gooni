"""Feature-request routing — creates a `feature-request`-tagged Note
(BacklogTicket died in the v2 nuke).

This handler was DEAD in production. It opened with a function-body
`from ...tools.feature_request_tool import feature_request_tool` — a name that
module has never exported (it defines the class `RequestFeatureTool` and the
shared function `create_feature_request_note`). The import sat outside the
per-item try, so `handle` raised ImportError on every call with a
feature_requests signal, and `intent_router` caught it into a `print`. Every
feature request Daniel voiced in chat was dropped, with a log line as the only
trace — the exact failure mode the rot audit predicted for these handlers.

Two things stop that recurring:

  * the import is MODULE-LEVEL now, so it is a boot-time failure that
    `tests/test_imports.py` walks and catches. A broken handler is not a bad
    signal; it must not be able to hide behind the per-signal swallow.
  * it calls `create_feature_request_note` — the function whose own docstring
    says "Shared with intent_handlers/features.py" — instead of
    `RequestFeatureTool.execute`, which returns a PROSE string. The old code
    read `tool_result.get("id")` behind `isinstance(tool_result, dict)`, which
    a string never satisfies, so `note_id` could not have been populated even
    had the import worked. That in turn made `_build_just_extracted_block`
    print "(id unknown)" forever, and the note editor's routed-features
    disclosure (which filters on a non-null id) permanently empty.
"""

from __future__ import annotations

import logging

from ...tools.feature_request_tool import create_feature_request_note

log = logging.getLogger(__name__)


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return

    for fr in items:
        title = (fr.get("title") or "").strip()
        why = (fr.get("why") or "").strip()
        if not title:
            continue
        try:
            # Returns the Note row — the existing one on a dedup hit — or None
            # if the insert failed. One bad signal must not kill the turn, so
            # this stays per-item; the handler-wide failure mode is now an
            # import error at boot instead.
            note = create_feature_request_note(ctx.db, title=title, why=why)
        except Exception:
            log.exception("[features handler] create failed for %r", title)
            continue
        if note is None:
            log.warning("[features handler] no note created for %r", title)
            continue
        result.captured_features.append({"title": title, "note_id": int(note.id)})
        result.tools_used.append("router:feature_request")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:feature_request",
                    label="Logged feature request",
                    args={"title": title, "why": why},
                )
            except Exception:
                log.exception("[features handler] trace hook error")
