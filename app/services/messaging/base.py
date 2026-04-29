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


def dispatch_inbound(
    channel: MessagingChannel,
    sender: str,
    text: str,
    db: Session,
    image_url: str | None = None,
) -> tuple[str, str] | None:
    """Common inbound pipeline: allowlist → orchestrator → format.

    Returns (raw_response, formatted_response), or None if the sender was
    rejected. Raw is the orchestrator's markdown; formatted is what the channel
    wants to put on the wire. We expose both so transports can fall back to
    raw text if the formatted send fails (e.g. Telegram rejecting malformed
    HTML).

    The caller is responsible for actually sending — Telegram replies inline
    via the Update object, iMessage POSTs to BlueBubbles. Splitting at this
    boundary keeps both transports idiomatic.
    """
    if not channel.is_allowed(sender):
        return None
    response, usage = Orchestrator.handle_chat(
        text, db, image_url=image_url, source=channel.name
    )
    _log_usage(usage)
    return response, channel.format_outbound(response)


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
