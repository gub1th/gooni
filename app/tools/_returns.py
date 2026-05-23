"""Structured tool-return contracts (phase 2 — backlog #313).

Write-tools return a typed dict instead of a free-text string so the LLM
reads an unambiguous `status` enum it can't misparse. Fixes the leetcode-
class bug at the source: when `set_todo_state` ran twice (a successful
close, then a redundant shorter-substring variant), the second call's
free-text "(no match)" string overwrote the first call's success in the
model's mental state and it narrated "couldn't close it, sir." A typed
`status="already_in_state"` on the second call removes the ambiguity.

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

from typing import Literal, TypedDict, Union

try:  # NotRequired landed in 3.11; fall back for older runtimes.
    from typing import NotRequired
except ImportError:  # pragma: no cover
    from typing_extensions import NotRequired  # type: ignore


# ── todo ────────────────────────────────────────────────────────────────
class TodoContext(TypedDict, total=False):
    matched_text: str       # the actual todo text the substring matched
    from_state: str         # state before the mutation (not_yet|doing|done)
    to_state: str           # state requested
    mention_count: int      # >1 when a duplicate create bumped an existing row


TodoStatus = Literal[
    "created",            # new todo inserted
    "duplicate",          # create cosine-matched an open todo; bumped it instead
    "closed",             # set_todo_state → done
    "reopened",           # set_todo_state → not_yet
    "started",            # set_todo_state → doing
    "already_in_state",   # match found but already in the requested state
    "not_found",          # no todo matched
    "invalid",            # bad input (empty text, unparseable due_date, etc.)
]


class TodoReturn(TypedDict):
    kind: Literal["todo"]
    id: int
    status: TodoStatus
    summary: str
    context: NotRequired[TodoContext]


# ── memory ───────────────────────────────────────────────────────────────
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


# ── list_item ──────────────────────────────────────────────────────────────
class ListItemContext(TypedDict, total=False):
    list_name: str
    item_text: str


ListItemStatus = Literal[
    "created",   # item appended
    "invalid",   # empty list_name / item
    "error",     # write failed
]


class ListItemReturn(TypedDict):
    kind: Literal["list_item"]
    id: int
    status: ListItemStatus
    summary: str
    context: NotRequired[ListItemContext]


# ── backlog_ticket ─────────────────────────────────────────────────────────
class BacklogTicketContext(TypedDict, total=False):
    title: str
    blast_radius: int
    hit_count: int          # total friction events on this ticket (repeat hits)
    severity_phrase: str    # "flagged blocker" | "logged" | "logged, minor"


BacklogTicketStatus = Literal[
    "created",     # brand-new ticket
    "duplicate",   # upsert hit an existing ticket; urgency bumped
    "invalid",     # missing title / no db
]


class BacklogTicketReturn(TypedDict):
    kind: Literal["backlog_ticket"]
    id: int
    status: BacklogTicketStatus
    summary: str
    context: NotRequired[BacklogTicketContext]


ToolReturn = Union[
    TodoReturn,
    MemoryReturn,
    ListItemReturn,
    BacklogTicketReturn,
]
