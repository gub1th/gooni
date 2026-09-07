"""One way for Gooni to say something on WhatsApp unprompted.

Before this, three callers (`proactive_service`'s silence reach-out,
`distraction_alert`, `fly_revive`'s boot apology) each hand-rolled the same
four steps: find the recipient, send, check that Meta actually accepted it, and
record the message as an assistant turn so the thread shows what Gooni said and
a reply lands in the right conversation. Three copies, and they had already
drifted — two different recipient resolvers (one of them reaching into the
channel's PRIVATE `_allowed` set), the channel name written as a bare
`"whatsapp"` in one place and a constant in another, and different opinions
about which half of the sequence deserved a try/except.

A fourth caller would have been a fourth copy, so this is the extraction.

**Delivery and record are not the same event, and the ordering is the rule.**
The transcript row is written only after Meta ACCEPTS — a row for a message
that was never delivered is a lie the message log can't distinguish from a real
one, and `proactive_service` learned that the hard way (audit 2026-06-10: the
old nudge layer stamped idempotency markers on sends Meta had rejected, and
died silently for weeks looking healthy). A failed RECORD, by contrast, does
not un-send anything, so it is logged and swallowed.

Nothing here decides WHETHER Gooni should speak. Cadence, dedup, per-day caps
and Meta's 24h freeform window stay with the callers, because each answers them
differently: the reach-out spends a once-a-day marker and must check the window
BEFORE it burns one, while a congratulation is bounded by the thing that
triggered it and can simply fail to send.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

#: The conversation `source` these messages are recorded against. One spelling.
CHANNEL = "whatsapp"


def recipient(channel=None) -> str | None:
    """The one allowlisted handle to text, or None if none is configured.

    Single-tenant by assumption: Daniel is the only recipient, and supporting
    more would need per-conversation handle tracking rather than a bigger set.
    That assumption was already baked into all three original call sites; this
    just states it once.

    Reads the channel's PUBLIC `default_recipient`. The old code reached into
    `_allowed` directly, which is how one caller quietly depended on a private
    attribute's iteration order.
    """
    if channel is None:
        # Lazy: messaging imports the orchestrator, which imports services.
        from .whatsapp import whatsapp_channel

        channel = whatsapp_channel
    return getattr(channel, "default_recipient", None)


def notify(db: Session, text: str, *, channel=None, record: bool = True) -> bool:
    """Send `text` on WhatsApp and record it on the thread. Returns delivered.

    Best-effort by contract: this is called from background loops, from an
    ingest path, and from the tail of a focus session's stop, and NONE of them
    may fail because a message didn't go out. Every failure mode returns False
    rather than raising.

    `record=False` is for a caller that writes its own transcript row with
    extra context — it must not end up with two.
    """
    if not text or not text.strip():
        return False

    if channel is None:
        from .whatsapp import whatsapp_channel

        channel = whatsapp_channel

    to = recipient(channel)
    if not to:
        print("[outbound] no allowlisted WhatsApp handle configured; staying quiet")
        return False

    try:
        delivered = channel.send(to, channel.format_outbound(text))
    except Exception as e:
        print(f"[outbound] send raised: {e}")
        return False

    if not delivered:
        # Meta refused, or the channel is unconfigured. No transcript row: the
        # log must not show Gooni saying something it never said.
        return False

    if record:
        try:
            from ..conversation_service import conversation_service

            conv = conversation_service.find_or_create_session(CHANNEL, db)
            conversation_service.add_message(conv.id, "assistant", text, db)
        except Exception as e:
            # The message HAS been delivered. A missing transcript row is a gap
            # in the log, not a failed send, and reporting it as one would make
            # a caller retry a message the human already read.
            print(f"[outbound] transcript record failed: {e}")

    return True
