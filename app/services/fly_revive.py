"""Fly-revive handshake — replies to WA messages orphaned by a server outage.

Problem: Fly killed the process mid-conversation. Daniel sent a message;
no reply ever came. When the process boots back up, those messages just
sit dead in the conversation log. From Daniel's side it looks like Gooni
ghosted him.

Fix: on boot, find WA conversations where the most-recent message is from
Daniel and there's no assistant reply after it (received within the
last 24h, so we don't apologize for ancient messages). Send a brief
"sorry, fly died, back online" message to each one and record it as an
assistant turn so the conversation log reflects the apology.

Idempotency is automatic: once the apology lands as an assistant Message
row, the conversation no longer has an orphan (user-last) tail, so the
next boot skips it.

Re-running the orchestrator over the orphaned user message to actually
ANSWER the question is intentionally deferred to a follow-up PR — that
surgery on handle_chat (which currently always inserts a fresh user
message) is bigger than v1 needs. v1 just stops the ghosting.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Conversation, Message
from .conversation_service import conversation_service


# Recovery window. If the orphan was sent more than this long ago, we
# treat it as too stale to apologize for — sending "sorry fly died" 3
# days late would just be weird.
_ORPHAN_LOOKBACK = timedelta(hours=24)

# Voice: friend texting after their phone died. Variants so back-to-back
# revives don't feel templated when Fly flap-loops.
_APOLOGIES = [
    "yo — fly died on me, just got back. sorry for the gap.",
    "back. fly was being annoying — sorry i went dark.",
    "alive again. hosting hiccup; sorry you got radio silence.",
    "ok i'm back — fly threw a fit. apologies for the drop.",
]


def _pick_apology() -> str:
    return random.choice(_APOLOGIES)


def catch_up_orphaned_messages(db: Session) -> int:
    """Find WA conversations where Daniel's last message has no assistant
    reply (within the last 24h) and send an apology. Returns count of
    apologies sent.

    Side effects: calls whatsapp_channel.send() for each orphan and
    appends an assistant Message row recording the apology.
    """
    cutoff = datetime.utcnow() - _ORPHAN_LOOKBACK

    # Imported lazily to dodge import-cycle (messaging imports orchestrator
    # which imports services).
    from .messaging.whatsapp import whatsapp_channel

    if not whatsapp_channel._allowed:
        # No allowlisted handles configured — nothing to send to.
        return 0

    # Single-tenant: pick any allowlisted handle as the recipient. If
    # multiple were configured we'd need per-conv handle tracking, but
    # Daniel's the only one.
    target_handle = next(iter(whatsapp_channel._allowed))

    convs = (
        db.query(Conversation)
        .filter(Conversation.source == "whatsapp")
        .all()
    )

    sent = 0
    for conv in convs:
        last_msg = (
            db.query(Message)
            .filter(Message.conversation_id == conv.id)
            .order_by(Message.created_at.desc())
            .first()
        )
        if last_msg is None or last_msg.role != "user":
            continue
        if last_msg.created_at is None or last_msg.created_at < cutoff:
            continue

        apology = _pick_apology()
        try:
            formatted = whatsapp_channel.format_outbound(apology)
            whatsapp_channel.send(target_handle, formatted)
        except Exception as e:
            print(f"[fly-revive] send failed for conv {conv.id}: {e}")
            continue

        # Record as assistant message so the conversation log shows the
        # apology and the orphan check sees this conv as resolved.
        try:
            conversation_service.add_message(conv.id, "assistant", apology, db)
        except Exception as e:
            print(f"[fly-revive] assistant-msg record failed for conv {conv.id}: {e}")
            # Continue — the apology was sent, the record is best-effort.
        sent += 1

    return sent
