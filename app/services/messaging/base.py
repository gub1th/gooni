import re
from abc import ABC, abstractmethod

from sqlalchemy.orm import Session

from ..orchestrator import Orchestrator


class MessagingChannel(ABC):
    """A bot-style messaging surface (Telegram, iMessage, ...).

    Each subclass owns: how to render the orchestrator's markdown for that
    surface, how to push outbound messages, and which senders are allowed.
    Inbound transport (long-polling, webhook) lives in the caller — channels
    are just stateless adapters.
    """

    name: str  # subclass attribute, used as Conversation.source

    @abstractmethod
    def format_outbound(self, text: str) -> str:
        """Render orchestrator markdown for this channel (HTML / plain / ...)."""

    @abstractmethod
    def send(self, recipient: str, text: str) -> None:
        """Push a message. Used for proactive sends (daily nudge, etc).
        For inline replies, callers may bypass this and reply via the inbound
        transport's native primitive (e.g. Telegram Update.reply_text)."""

    @abstractmethod
    def is_allowed(self, sender_handle: str) -> bool:
        """Allowlist gate. Sender format is channel-specific (chat_id for
        Telegram, phone/email for iMessage)."""


# ── Multi-bubble reply splitter ────────────────────────────────────────────
# Bot channels (WA/Telegram/iMessage) feel more human when long replies arrive
# as a few short bubbles instead of one wall of text. Web chat keeps the full
# markdown response — splitting there would fight the rendered formatting.

_PARA_RE = re.compile(r"\n\s*\n")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")

# Tuning. Short enough to read on phone glance, long enough that we're not
# fragmenting every clause. 4 bubbles max keeps notifications sane.
# _MIN_SEGMENT_CHARS lowered from 40 → 18 in the WA-promises rewrite:
# Daniel called out the prior "one line / newline / one line / two newlines"
# in-bubble pattern as mechanical-reading. The merge step was greedily
# concatenating ≤40-char bubbles into a single bubble with internal \n
# breaks, which is exactly that ugly pattern. Lower threshold keeps short
# intentional bubbles as their own messages.
_MIN_SEGMENT_CHARS = 18
_MAX_SEGMENT_CHARS = 320
_MAX_SEGMENTS = 4


def split_for_bots(text: str) -> list[str]:
    """Split orchestrator output into 1–4 short message bubbles.

    Pipeline:
      1. Split on blank lines (paragraph boundaries the LLM emitted).
      2. Further split any paragraph > _MAX_SEGMENT_CHARS at sentence breaks.
      3. Merge consecutive short fragments so we don't ship 1-word bubbles.
      4. Cap at _MAX_SEGMENTS — overflow dumped into the last bubble.

    Single-paragraph short replies (the common chat case) pass through as one
    segment unchanged.
    """
    raw = (text or "").strip()
    if not raw:
        return []

    paragraphs = [p.strip() for p in _PARA_RE.split(raw) if p.strip()]
    if not paragraphs:
        return [raw]

    pieces: list[str] = []
    for para in paragraphs:
        if len(para) <= _MAX_SEGMENT_CHARS:
            pieces.append(para)
            continue
        # Long paragraph: break on sentence boundaries. Greedy pack into
        # bubbles until adding the next sentence would overflow.
        sentences = _SENTENCE_RE.split(para)
        current = ""
        for s in sentences:
            s = s.strip()
            if not s:
                continue
            if not current:
                current = s
            elif len(current) + 1 + len(s) <= _MAX_SEGMENT_CHARS:
                current = f"{current} {s}"
            else:
                pieces.append(current)
                current = s
        if current:
            pieces.append(current)

    # Merge short consecutive pieces to avoid one-word bubbles.
    merged: list[str] = []
    for p in pieces:
        if merged and len(merged[-1]) < _MIN_SEGMENT_CHARS:
            merged[-1] = f"{merged[-1]}\n{p}"
        else:
            merged.append(p)

    # Cap segment count — collapse overflow into the last bubble.
    if len(merged) > _MAX_SEGMENTS:
        head = merged[: _MAX_SEGMENTS - 1]
        tail = "\n\n".join(merged[_MAX_SEGMENTS - 1 :])
        merged = head + [tail]

    return merged


def dispatch_inbound(
    channel: MessagingChannel,
    sender: str,
    text: str,
    db: Session,
    image_url: str | None = None,
) -> tuple[str, list[str]] | None:
    """Common inbound pipeline: allowlist → orchestrator → split → format.

    Returns (raw_response, [formatted_segments]), or None if the sender was
    rejected. Raw is the orchestrator's full markdown; segments are the
    channel-formatted bubbles ready for the wire — typically 1 short, 2–4
    when the reply is longer. Callers iterate segments and send each.

    Splitting happens on raw text first, then per-segment formatting runs so
    HTML/markdown can never be split across a bubble boundary.
    """
    if not channel.is_allowed(sender):
        return None
    response, usage = Orchestrator.handle_chat(
        text, db, image_url=image_url, source=channel.name
    )
    _log_usage(usage)
    raw_segments = split_for_bots(response) or [response]
    formatted_segments = [channel.format_outbound(s) for s in raw_segments]
    return response, formatted_segments


def _log_usage(usage: dict | None) -> None:
    if not usage:
        return
    tools_used = usage.get("tools_used", [])
    if tools_used:
        print(f"[tools] {', '.join(tools_used)}")
    mem = usage.get("memory", {})
    parts = []
    if mem.get("memories_saved"):
        parts.append(f"{mem['memories_saved']} memories")
    if mem.get("note_saved"):
        parts.append("note logged")
    if parts:
        print(f"[memory] {' · '.join(parts)}")
