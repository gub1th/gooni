import os

import httpx

from .base import BaseTransport


class TelegramTransport(BaseTransport):
    """Send messages via the Telegram Bot API (synchronous HTTP calls).

    `to` should be a Telegram chat_id (string or int).
    Falls back to TELEGRAM_CHAT_ID env var when `to` is empty.
    """

    def __init__(self):
        token = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self.base_url = f"https://api.telegram.org/bot{token}"
        self.default_chat_id = os.getenv("TELEGRAM_CHAT_ID", "")

    def _chat_id(self, to: str) -> str:
        return to or self.default_chat_id

    def send(self, to: str, text: str) -> None:
        httpx.post(
            f"{self.base_url}/sendMessage",
            json={"chat_id": self._chat_id(to), "text": text},
            timeout=10,
        )

    def send_media(self, to: str, text: str, media_url: str) -> None:
        httpx.post(
            f"{self.base_url}/sendPhoto",
            json={"chat_id": self._chat_id(to), "photo": media_url, "caption": text},
            timeout=10,
        )
