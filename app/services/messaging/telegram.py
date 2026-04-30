import os
import re

from .base import MessagingChannel


def _markdown_to_telegram_html(text: str) -> str:
    """Convert the LLM's markdown to Telegram HTML so **bold** / `code` /
    [text](url) actually render. parse_mode='HTML' is more lenient than
    Telegram's MarkdownV2 (no need to escape every `.`/`-`/etc).

    Order matters: escape HTML chars first, THEN substitute markdown so the
    pattern characters aren't blown away by escaping.
    """
    if not text:
        return ""
    out = (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
    )
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out, flags=re.DOTALL)
    out = re.sub(r"`([^`\n]+?)`", r"<code>\1</code>", out)
    out = re.sub(
        r"\[([^\]]+)\]\((https?://[^\s)]+)\)",
        r'<a href="\2">\1</a>',
        out,
    )
    # Italic: *text* — must run AFTER bold. Skip when adjacent to digits/word
    # chars (avoids 2*3 etc).
    out = re.sub(
        r"(?<![\*\w])\*([^\*\n]+?)\*(?!\w)",
        r"<i>\1</i>",
        out,
    )
    return out


def _parse_chat_ids(raw: str | None) -> list[int]:
    """Parse TELEGRAM_CHAT_ID env. Single id or comma-separated."""
    if not raw:
        return []
    ids: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            ids.append(int(chunk))
        except ValueError:
            raise ValueError(f"TELEGRAM_CHAT_ID contains non-integer value: {chunk!r}")
    return ids


class TelegramChannel(MessagingChannel):
    name = "telegram"

    def __init__(self, allowed_chat_ids: list[int], unfiltered: bool = False):
        self._allowed = set(allowed_chat_ids)
        self._unfiltered = unfiltered
        # Late-bound: the bot script wires this to ApplicationBuilder().bot
        # after construction. Keeps this module free of python-telegram-bot
        # imports so the FastAPI process can import it without pulling the bot
        # library into the API container.
        self._bot = None

    def attach_bot(self, bot) -> None:
        """Called by scripts/telegram_bot.py once the python-telegram-bot
        Application is built. Outbound proactive sends route through this."""
        self._bot = bot

    def format_outbound(self, text: str) -> str:
        return _markdown_to_telegram_html(text)

    def is_allowed(self, sender_handle: str) -> bool:
        if self._unfiltered:
            return True
        try:
            chat_id = int(sender_handle)
        except (TypeError, ValueError):
            return False
        return chat_id in self._allowed

    def send(self, recipient: str, text: str) -> None:
        """Proactive send (used by daily nudge).

        Path A — same process as the bot polling loop: schedule on the bot's
        asyncio loop so we don't open extra HTTPS connections.
        Path B — separate process (FastAPI nudge scheduler in start.sh): the
        bot handle is None here, so fall back to raw Telegram Bot API over
        httpx. Same effect, costs one extra TLS handshake per send.

        Inline replies should still use Update.reply_text directly to stay on
        the same asyncio context.
        """
        if self._bot is not None:
            import asyncio
            asyncio.create_task(self._bot.send_message(chat_id=int(recipient), text=text))
            return
        token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not token:
            print(f"[telegram] no bot, no token; would send to {recipient}: {text[:60]}")
            return
        try:
            import httpx
            r = httpx.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": int(recipient), "text": text},
                timeout=10.0,
            )
            if r.status_code >= 400:
                print(f"[telegram] http send failed {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"[telegram] http send error: {e}")

    @property
    def allowed_chat_ids(self) -> list[int]:
        return sorted(self._allowed)


def _build_default() -> TelegramChannel:
    """Singleton factory. Reads env at import time to mirror existing pattern."""
    allowed = _parse_chat_ids(os.getenv("TELEGRAM_CHAT_ID"))
    unfiltered = os.getenv("ALLOW_UNFILTERED_TELEGRAM") == "1"
    return TelegramChannel(allowed_chat_ids=allowed, unfiltered=unfiltered)


telegram_channel = _build_default()
