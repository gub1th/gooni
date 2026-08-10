"""Audit rows for MCP tool invocations.

One writer for both MCP transports, so a tool's usage record does not depend on
which client called it. Reuses the existing `tool_calls` table rather than
adding a parallel one — the question ("which tools does anything actually
call?") is the same question the chat loop's rows already answer, and a second
table would mean two half-answers.

`ToolCall.conversation_id` / `message_id` stay NULL for MCP rows: an MCP call
has no Gooni conversation behind it. `source` is what distinguishes them.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

# Cap on the serialized blobs. An audit row is for "was this called and did it
# work", not for replaying payloads — and a `log_note` body can be arbitrarily
# long, which would make the audit table larger than the notes it describes.
_MAX_BLOB = 2000


def _dump(value: Any) -> str | None:
    if value is None:
        return None
    try:
        text = json.dumps(value, default=str)
    except (TypeError, ValueError):
        text = str(value)
    return text[:_MAX_BLOB]


def record_call(
    db: Session,
    *,
    tool_name: str,
    source: str,
    args: Any = None,
    status: str = "done",
    result: Any = None,
    error: str | None = None,
) -> int | None:
    """Insert one completed tool-call row. Flushes but does NOT commit — the
    caller owns the transaction boundary.

    Never raises: an audit failure must not turn a successful write into a
    reported error, which would tell Claude a captured thought was lost when it
    was not.
    """
    from ..db.models import ToolCall

    try:
        now = datetime.utcnow()
        row = ToolCall(
            tool_name=tool_name,
            source=source,
            args_json=_dump(args),
            status=status,
            result_json=_dump(result),
            error=(str(error)[:_MAX_BLOB] if error else None),
            started_at=now,
            finished_at=now,
        )
        db.add(row)
        db.flush()
        return row.id
    except Exception as exc:  # noqa: BLE001 — audit is best-effort, see docstring
        print(f"[mcp_logging] could not record {tool_name}: {exc}")
        return None
