import os
import re
import uuid

import httpx

from .base import MessagingChannel


def _strip_markdown(text: str) -> str:
    """Best-effort markdown → plain text. iMessage has no rich-text rendering
    (no bold, no inline code styling), so we just unwrap the markers and let
    the literal text through.
    """
    if not text:
        return ""
    out = text
    out = re.sub(r"\*\*(.+?)\*\*", r"\1", out, flags=re.DOTALL)  # **bold**
    out = re.sub(r"(?<![\*\w])\*([^\*\n]+?)\*(?!\w)", r"\1", out)  # *italic*
    out = re.sub(r"`([^`\n]+?)`", r"\1", out)  # `code`
    out = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", r"\1 (\2)", out)  # [t](u)
    return out


def _parse_handle_list(raw: str | None) -> set[str]:
    """Comma-separated handles → set, normalized (lowercased emails, stripped)."""
    if not raw:
        return set()
    out: set[str] = set()
    for chunk in raw.split(","):
        h = chunk.strip()
        if not h:
            continue
        # Lowercase emails so daniel@me.com == Daniel@ME.com; leave numbers alone.
        if "@" in h:
            h = h.lower()
        out.add(h)
    return out


def _normalize_handle(handle: str) -> str:
    if "@" in handle:
        return handle.lower()
    return handle


class BlueBubblesClient:
    """Thin client for the BlueBubbles server REST API.

    https://documentation.bluebubbles.app/server/rest-api-reference

    No-op when bridge_url/password unset — lets the webhook be exercised end-
    to-end on a Mac-less laptop without 500ing the moment we try to reply.
    """

    def __init__(self, bridge_url: str | None, password: str | None,
                 timeout: float = 10.0):
        self._url = (bridge_url or "").rstrip("/")
        self._password = password
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self._url and self._password)

    def send_text(self, recipient: str, text: str) -> None:
        if not self.configured:
            print(
                f"[imessage] bridge not configured; would send to "
                f"{recipient}: {text[:60]}"
            )
            return
        # BlueBubbles addresses chats by chatGuid. For 1:1 iMessage, the
        # canonical form is "iMessage;-;<address>". chatGuid lookup-by-address
        # is also supported via the /chat/{address}/message endpoint, but the
        # /message/text shape here is the documented happy path.
        chat_guid = f"iMessage;-;{recipient}"
        payload = {
            "chatGuid": chat_guid,
            "tempGuid": str(uuid.uuid4()),
            "message": text,
            "method": "apple-script",
        }
        try:
            r = httpx.post(
                f"{self._url}/api/v1/message/text",
                params={"password": self._password},
                json=payload,
                timeout=self._timeout,
            )
            if r.status_code >= 400:
                print(f"[imessage] send failed {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"[imessage] send error: {e}")


class IMessageChannel(MessagingChannel):
    name = "imessage"

    def __init__(self, client: BlueBubblesClient, allowed_handles: set[str]):
        self._client = client
        self._allowed = allowed_handles

    def format_outbound(self, text: str) -> str:
        return _strip_markdown(text)

    def is_allowed(self, sender_handle: str) -> bool:
        if not sender_handle:
            return False
        return _normalize_handle(sender_handle) in self._allowed

    def send(self, recipient: str, text: str) -> None:
        self._client.send_text(recipient, text)


def _build_default() -> IMessageChannel:
    client = BlueBubblesClient(
        bridge_url=os.getenv("IMESSAGE_BRIDGE_URL"),
        password=os.getenv("IMESSAGE_BRIDGE_PASSWORD"),
    )
    allowed = _parse_handle_list(os.getenv("IMESSAGE_ALLOWED_HANDLES"))
    return IMessageChannel(client=client, allowed_handles=allowed)


imessage_channel = _build_default()
