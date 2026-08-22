"""ONE capture flow. Both entry points into the intent pipeline run through it.

The chat orchestrator and `classify_note` each did the same three things —
extract signals, dispatch them through `intent_router`, summarize what landed
— behind ~30 lines of hand-rolled adapter apiece. `intent_router.dispatch` was
already shared (it exists precisely because three copy-pasted if-blocks had
drifted between the chat and note-save paths). The ADAPTERS then drifted the
same way, one layer up, and produced two real bugs:

  1. `classify_note` had NO `extract_failed` branch. The orchestrator treats a
     dead extractor as trust-fatal, stamps the message row, and offers a
     retry. On the note path a failed extraction wrote
     `{"memory_count": 0, ...}` — byte-identical to "classified fine, nothing
     to capture" — and then the dedup gate snapshotted `classified_embedding`,
     so that note was NEVER retried. Silent permanent capture loss.

  2. Memories took different paths. Chat strips them from dispatch and
     reconciles off-thread; notes passed them straight through to
     `_apply_add`. Same extractor, two qualities of write, for no stated
     reason.

WHAT GENUINELY DIFFERS between the two callers, and is therefore a parameter
rather than a branch: whether a reply follows, where the summary lands, and
provenance. All three are already expressed by `RouterContext`
(`source_message_id` vs `source_note_id`), which is why this is one function
and not two with a flag.

WHAT IS NOT HERE: reply generation, the verify rail, the write ledger, the
note dedup gate. Those belong to their callers. This owns extract -> guard ->
dispatch -> summarize, and nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session


@dataclass
class CaptureResult:
    """What one capture produced.

    `routed` is the RouterResult verbatim — callers that already read it (the
    ack builder, the verify rail) are unchanged. `failed` and `summary` are
    the two things both callers needed and each had reimplemented.
    """

    routed: Any
    signals: dict = field(default_factory=dict)
    # True when the EXTRACTOR died — not when it found nothing. The
    # distinction is the whole point: "no signal" is a fine outcome, "the
    # call failed" means this text's captures are lost unless something
    # retries. Callers must persist it somewhere a retry can find.
    failed: bool = False
    summary: dict = field(default_factory=dict)


def capture(
    text: str,
    ctx,
    *,
    db: Session,
    prev_assistant: str | None = None,
    route_memories: bool = False,
) -> CaptureResult:
    """Extract signals from `text` and route them. THE capture path.

    `route_memories=False` (the default, and what chat does) strips memory
    candidates before dispatch so the caller can reconcile them off-thread.
    It is a parameter rather than a hardcoded choice because the two callers
    genuinely disagreed about it in production and the disagreement should be
    visible at the call site, not buried here.

    Never raises: a failed extraction returns `failed=True` with an empty
    RouterResult, because losing the turn's reply on top of losing its
    captures is strictly worse.
    """
    from ..common import local_today
    from . import intent_router
    from .memory_extraction import extract_signals

    try:
        signals = extract_signals(
            text, prev_assistant=prev_assistant, today=local_today(db)
        )
    except Exception as e:
        print(f"[capture] extract_signals raised: {e}")
        return CaptureResult(
            routed=intent_router.RouterResult(),
            signals={},
            failed=True,
            summary=summarize(intent_router.RouterResult(), failed=True),
        )

    failed = bool(signals.get("extract_failed"))
    payload = signals if route_memories else {**signals, "memories": []}

    try:
        routed = intent_router.dispatch(payload, ctx)
    except Exception as e:
        # dispatch already guards each handler individually; this is the
        # backstop for a failure in the dispatcher itself.
        print(f"[capture] dispatch raised: {e}")
        routed = intent_router.RouterResult()

    return CaptureResult(
        routed=routed,
        signals=signals,
        failed=failed,
        summary=summarize(routed, failed=failed),
    )


def summarize(routed, *, failed: bool = False) -> dict:
    """The stored snapshot of what a capture routed.

    ONE shape for both surfaces. The chat side writes it to
    `Message.signal_preview` and the note side to `Note.last_classify_signals`;
    they had two hand-built dicts describing the same thing.

    `status` is what makes a failure legible downstream. An empty summary with
    `status: "ok"` means "nothing to capture"; `status: "extract_failed"`
    means "we don't know" — and a surface that can't tell them apart will
    render silence for both.
    """
    from datetime import datetime, timezone

    feature_summaries = [
        # `list_item_id` keeps its historical key name so the note editor's
        # disclosure renders unchanged. It is a Note id and has been since
        # the v2 nuke.
        {"title": f["title"], "list_item_id": f["note_id"]}
        for f in (getattr(routed, "captured_features", None) or [])
        if f.get("note_id") is not None
    ]
    written = getattr(routed, "memories_written", None) or []
    return {
        "feature_requests": feature_summaries,
        "memory_count": len(written),
        "memory_types": [m.type for m in written],
        "status": "extract_failed" if failed else "ok",
        "classified_at": datetime.now(timezone.utc).isoformat(),
    }
