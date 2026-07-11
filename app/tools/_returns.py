"""Structured tool-return contracts.

Write-tools return a typed dict instead of a free-text string so the LLM
reads an unambiguous `status` enum it can't misparse. (Born as backlog #313
to fix a duplicate-tool-call ambiguity bug; the Todo/ListItem/BacklogTicket
contracts died with their primitives in the v2 nuke — Memory is the one
write-tool surface left.)

Contract per return:
  - `kind`    — discriminator. Redundant for the Python caller (which
                knows the tool), but gives the LLM a stable shape across
                tools.
  - `id`      — real DB row id. 0 = no row (failure / not-found). The id
                is INTERNAL grounding only — it is NEVER rendered to the
                user (see feedback_alfred-voice-acks). It exists so the
                LLM can reason "did this land?" and so audit can stitch.
  - `status`  — per-kind Literal enum. The field the LLM branches on.
  - `summary` — human-readable prose for the LLM to paraphrase into its
                reply. The ONLY free-text field — everything load-bearing
                lives in `status` / `context`.
  - `context` — optional, per-kind typed payload. Closes the "shove
                unstructured stuff in a dict" loophole.

The client (`app/llm/client.py::_execute_with_audit`) json.dumps a dict
return before feeding it to the LLM + writing the ToolCall audit row.
Tools that still return `str` pass through unchanged (back-compat).
"""

from __future__ import annotations

from typing import Literal, TypedDict

try:  # NotRequired landed in 3.11; fall back for older runtimes.
    from typing import NotRequired
except ImportError:  # pragma: no cover
    from typing_extensions import NotRequired  # type: ignore


class MemoryContext(TypedDict, total=False):
    type: str  # episode | fact | preference


MemoryStatus = Literal[
    "created",   # memory row written
    "invalid",   # empty content
    "error",     # write failed
]


class MemoryReturn(TypedDict):
    kind: Literal["memory"]
    id: int
    status: MemoryStatus
    summary: str
    context: NotRequired[MemoryContext]
