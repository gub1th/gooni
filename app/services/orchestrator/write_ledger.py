"""Turn-scoped write ledger — ONE reconstruction of what a turn changed.

The orchestrator has TWO writers and they cannot see each other.
`intent_router` fires promise / feature / tone hooks UPSTREAM of the chat
model (before a single reply token exists), while the chat tool loop writes
from INSIDE it and leaves `ToolCall` audit rows behind. Nothing joined the
two, so "did the reply's claim actually land?" had several independent
answers — and the verify step's answer was the worst of them: a blanket
`ROUTER-LAYER CLAIMS ok=true` clause in `_VERIFY_PROMPT` that whitelisted
every router-flavoured verb whether or not the router had fired at all.
It defeated the check it existed to run: the one case the verify rail is
for — the model narrating a write nobody performed — was the case the rule
waved through.

This module is the join. It is DERIVED, not appended to: `RouterResult` is
already the router's ledger and the `ToolCall` rows are already the tool
loop's, so folding both into one list needs no new plumbing through the
handlers or the tool loop, and no new table. Both the deterministic rail and
the LLM verifier read this and only this, so the two can no longer disagree
about what the turn wrote.

The rendering is the point as much as the data. A write the verifier must
NOT treat as backing a claim is still listed — loudly marked — rather than
omitted, because the failure this fixes is a verifier reasoning from absence:

  * ``NOT WRITTEN`` — a promise GLOW. Chat-side promise creates have not
    inserted rows since Slice 3; the router annotates the source Message and
    Daniel promotes it later. A draft saying "added that promise" off a glow
    is exactly the lie the old whitelist blessed by name.
  * ``queued, unconfirmed`` — a tone preference. `add_feedback_preference`
    runs on a daemon thread, so the turn cannot know it landed. Same reason
    `RouterResult.wrote_anything` excludes memories.
  * ``read-only`` — a chat tool that reads. Reading a note does not back
    "saved it".
  * ``FAILED`` — the write was attempted and did not land.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ...db.models import ToolCall as ToolCallModel

# Read-only CHAT-registry tools whose presence in the audit doesn't justify a
# "tracked/saved" claim. Must track app/tools/__init__.py registry names — an
# earlier copy of this set was lifted from the MCP surface (~15 nonexistent
# names, 7 real read tools missing), which let read-only turns pass as writes.
READ_ONLY_TOOLS = {
    "list_recent_notes", "read_note", "find_note", "search_notes",
    "list_promises", "read_trackable",
    "web_search", "fetch_url",
    "check_calendar_busy", "list_upcoming_events",
}

#: A write that LANDED. Only this status may back a state-changing claim.
DONE = "done"
#: Attempted, did not land.
FAILED = "failed"
#: Dispatched off-thread — this turn cannot know the outcome.
QUEUED = "queued"
#: Deliberately NOT a write (a glow annotation awaiting promotion).
NOTICED = "noticed"
#: A chat tool that only read.
READ = "read"
#: Inserted before execute, never resolved.
UNFINISHED = "unfinished"

_STATUS_NOTE = {
    FAILED: "FAILED — did not land",
    QUEUED: "queued, unconfirmed — dispatched off-thread",
    NOTICED: "NOT WRITTEN — noticed only, awaiting review",
    READ: "read-only — backs no write claim",
    UNFINISHED: "unfinished — never reported a result",
}


def _preview(value: Any, limit: int = 80) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split())
    return text[: limit - 1] + "…" if len(text) > limit else text


@dataclass(frozen=True)
class WriteRecord:
    """One thing a turn did (or conspicuously did not do)."""

    layer: str          # "router" | "tool"
    action: str         # what was attempted
    status: str         # DONE | FAILED | QUEUED | NOTICED | READ | UNFINISHED
    obj: str = ""       # the object it landed on, for claim matching
    ref: str = ""       # durable id, e.g. "Note #12"

    @property
    def backs_a_claim(self) -> bool:
        """True only for writes that actually landed in this turn."""
        return self.status == DONE

    def render(self) -> str:
        bits = [f"- [{self.layer}] {self.action}"]
        note = _STATUS_NOTE.get(self.status)
        if note:
            bits.append(f" ({note})")
        if self.ref:
            bits.append(f" → {self.ref}")
        if self.obj:
            bits.append(f' · "{self.obj}"')
        return "".join(bits)


@dataclass
class WriteLedger:
    records: list[WriteRecord] = field(default_factory=list)
    #: False when the ToolCall audit could not be read. The verify rail
    #: fails OPEN on that — an unreadable audit is not evidence of a lie.
    audit_readable: bool = True

    def backing_writes(self) -> list[WriteRecord]:
        return [r for r in self.records if r.backs_a_claim]

    def render(self) -> str:
        """The audit block handed to the verifier."""
        lines = [r.render() for r in self.records]
        if not self.audit_readable:
            lines.append(
                "- [tool] (audit unreadable this turn — assume tools may have "
                "run; do NOT call the draft unbacked on this basis)"
            )
        if not lines:
            return "(nothing was written this turn — no router captures, no tool calls)"
        return "\n".join(lines)


def _router_records(routed: Any) -> list[WriteRecord]:
    """Fold a RouterResult into records. Defensive `getattr` throughout: the
    note-save surface builds a leaner context and the eval harness passes
    stubs, and a missing field must read as "nothing routed", not a crash in
    the rail whose entire job is to be trustworthy."""
    out: list[WriteRecord] = []

    for f in getattr(routed, "captured_features", None) or []:
        note_id = f.get("note_id")
        out.append(WriteRecord(
            layer="router",
            action="logged feature request",
            status=DONE,
            obj=_preview(f.get("title")),
            ref=f"Note #{note_id}" if note_id else "",
        ))

    for p in getattr(routed, "captured_promises", None) or []:
        out.append(WriteRecord(
            layer="router",
            action="created promise",
            status=DONE,
            obj=_preview(p.get("summary") or p.get("utterance")),
            ref=f"Promise #{p.get('id')}" if p.get("id") else "",
        ))

    for p in getattr(routed, "completed_promises", None) or []:
        out.append(WriteRecord(
            layer="router",
            action="marked promise kept",
            status=DONE,
            obj=_preview(p.get("summary") or p.get("utterance")),
            ref=f"Promise #{p.get('id')}" if p.get("id") else "",
        ))

    for p in getattr(routed, "broken_promises", None) or []:
        out.append(WriteRecord(
            layer="router",
            action="marked promise broken",
            status=DONE,
            obj=_preview(p.get("summary") or p.get("utterance")),
            ref=f"Promise #{p.get('id')}" if p.get("id") else "",
        ))

    # Glow: the source Message is annotated and NO Promise row is created.
    # Listed so the verifier can deny a "tracked it" claim explicitly rather
    # than infer the absence of a write from an empty ledger.
    for s in getattr(routed, "noticed_promises", None) or []:
        out.append(WriteRecord(
            layer="router",
            action="noticed a commitment (glow on the message)",
            status=NOTICED,
            obj=_preview(s.get("summary") or s.get("utterance")),
        ))

    # Tone preferences land on a daemon thread; the turn never learns whether
    # the write succeeded, so it cannot back a "saved that" claim.
    for rule in getattr(routed, "tone_rules", None) or []:
        out.append(WriteRecord(
            layer="router",
            action="tone preference",
            status=QUEUED,
            obj=_preview(rule),
        ))

    for fa in getattr(routed, "failed_promise_actions", None) or []:
        kind = fa.get("kind") or "resolve"
        reason = "ambiguous match" if fa.get("candidates") else "no active match"
        out.append(WriteRecord(
            layer="router",
            action=f"promise {kind} ({reason})",
            status=FAILED,
            obj=_preview(fa.get("match")),
        ))

    return out


def _tool_records(tool_call_ids: list[int], db) -> tuple[list[WriteRecord], bool]:
    if not tool_call_ids:
        return [], True
    try:
        rows = (
            db.query(ToolCallModel)
            .filter(ToolCallModel.id.in_(tool_call_ids))
            .all()
        )
    except Exception as e:
        print(f"[write_ledger] audit read failed: {e}")
        return [], False

    out: list[WriteRecord] = []
    for r in rows:
        name = r.tool_name or "(unnamed tool)"
        if r.status == "done":
            status = READ if name in READ_ONLY_TOOLS else DONE
        elif r.status == "failed":
            status = FAILED
        else:
            status = UNFINISHED
        out.append(WriteRecord(
            layer="tool",
            action=name,
            status=status,
            obj=_tool_object(r),
            ref=f"ToolCall #{r.id}",
        ))
    return out, True


def _tool_object(row: ToolCallModel) -> str:
    """A short, honest label for what a tool call acted on. Args are the only
    generic handle — every tool shapes them differently, so the first string
    value is a better guess than any per-tool special case, and a bad guess
    costs the verifier nothing (the tool NAME is what it matches on)."""
    if row.error:
        return _preview(row.error)
    raw = row.args_json
    if not raw:
        return ""
    try:
        args = json.loads(raw)
    except Exception:
        return _preview(raw)
    if isinstance(args, dict):
        for key in ("name", "title", "content", "query", "q", "text"):
            if isinstance(args.get(key), str) and args[key].strip():
                return _preview(args[key])
        return _preview(", ".join(f"{k}={v}" for k, v in list(args.items())[:3]))
    return _preview(args)


def build_ledger(*, routed: Any, tool_call_ids: list[int] | None, db) -> WriteLedger:
    """Join this turn's router captures and tool audit into one ledger.

    Router records come first: they happened first (upstream of the model) and
    reading them first is how the verifier learns that a tool-less turn can
    still be honest.
    """
    tools, readable = _tool_records(list(tool_call_ids or []), db)
    return WriteLedger(
        records=_router_records(routed) + tools,
        audit_readable=readable,
    )
