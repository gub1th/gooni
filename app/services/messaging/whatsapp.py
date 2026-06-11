import os
import re

import httpx

from .base import MessagingChannel


# WhatsApp accepts a small subset of formatting markers. Different from
# standard markdown — single asterisks for bold, single underscores for italic,
# tildes for strike, backticks for monospace. Conversion below targets these.
def _markdown_to_whatsapp(text: str) -> str:
    if not text:
        return ""
    out = text
    # **bold** → *bold*  (bold uses single asterisks in WhatsApp).
    out = re.sub(r"\*\*(.+?)\*\*", r"*\1*", out, flags=re.DOTALL)
    # *italic* → _italic_  (only when not already part of a bold marker — the
    # bold pass above consumed those, so any remaining single asterisk is
    # italic in our markdown convention).
    out = re.sub(r"(?<![\*\w])\*([^\*\n]+?)\*(?!\w)", r"_\1_", out)
    # [text](url) → text (url).  WhatsApp doesn't render anchors; keep both
    # the label and the URL so the message is still useful.
    out = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", r"\1 (\2)", out)
    # `code` survives unchanged (WhatsApp uses single backticks).
    return out


def _parse_handle_list(raw: str | None) -> set[str]:
    """Comma-separated phone numbers. Normalize to digits-only so `+1 555…`
    and `15551234567` compare equal."""
    if not raw:
        return set()
    out: set[str] = set()
    for chunk in raw.split(","):
        h = re.sub(r"\D+", "", chunk)
        if h:
            out.add(h)
    return out


def _normalize_handle(h: str) -> str:
    return re.sub(r"\D+", "", h or "")


class WhatsAppCloudClient:
    """Thin client for WhatsApp Cloud API (Meta).

    Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

    No-op when phone_number_id/access_token unset — lets the webhook be wired
    end-to-end before the Meta credentials are issued, mirroring the
    BlueBubbles client's behavior.
    """

    GRAPH_BASE = "https://graph.facebook.com/v22.0"

    def __init__(self, phone_number_id: str | None, access_token: str | None,
                 timeout: float = 10.0):
        self._pnid = phone_number_id or ""
        self._token = access_token or ""
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self._pnid and self._token)

    def send_text(self, recipient: str, text: str) -> bool:
        """Return True only when Meta accepted the message. Failures used
        to be swallowed (print + None), which made every caller's success
        check pass — proactive nudges stamped their idempotency tokens on
        messages Meta rejected and the layer could die silently (audit
        2026-06-10)."""
        if not self.configured:
            print(
                f"[whatsapp] cloud api not configured; would send to "
                f"{recipient}: {text[:60]}"
            )
            return False
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": recipient,
            "type": "text",
            "text": {"body": text, "preview_url": True},
        }
        try:
            r = httpx.post(
                f"{self.GRAPH_BASE}/{self._pnid}/messages",
                headers={"Authorization": f"Bearer {self._token}"},
                json=payload,
                timeout=self._timeout,
            )
            if r.status_code >= 400:
                print(f"[whatsapp] send failed {r.status_code}: {r.text[:200]}")
                return False
            return True
        except Exception as e:
            print(f"[whatsapp] send error: {e}")
            return False


class WhatsAppChannel(MessagingChannel):
    name = "whatsapp"

    def __init__(self, client: WhatsAppCloudClient, allowed_handles: set[str]):
        self._client = client
        self._allowed = allowed_handles

    def format_outbound(self, text: str) -> str:
        return _markdown_to_whatsapp(text)

    def is_allowed(self, sender_handle: str) -> bool:
        if not sender_handle:
            return False
        return _normalize_handle(sender_handle) in self._allowed

    def send(self, recipient: str, text: str) -> bool:
        return self._client.send_text(_normalize_handle(recipient), text)


def _build_default() -> WhatsAppChannel:
    client = WhatsAppCloudClient(
        phone_number_id=os.getenv("WHATSAPP_PHONE_NUMBER_ID"),
        access_token=os.getenv("WHATSAPP_ACCESS_TOKEN"),
    )
    allowed = _parse_handle_list(os.getenv("WHATSAPP_ALLOWED_HANDLES"))
    return WhatsAppChannel(client=client, allowed_handles=allowed)


whatsapp_channel = _build_default()
