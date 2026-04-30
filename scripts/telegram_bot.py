import asyncio
import base64
import os
import re
import tempfile

from dotenv import load_dotenv

load_dotenv()  # must run before app.* imports that read env at import time

from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.db.database import SessionLocal, engine
from app.db.models import Base
from app.llm.client import llm_client
from app.services.messaging import dispatch_inbound, telegram_channel
from app.services.todo_nudge import resolve_digest_reply

Base.metadata.create_all(bind=engine)


async def _respond(update: Update, message: str, image_url: str | None = None) -> None:
    chat_id = update.message.chat_id

    def chat_fn():
        db = SessionLocal()
        try:
            return dispatch_inbound(
                telegram_channel,
                str(chat_id),
                message,
                db,
                image_url=image_url,
            )
        finally:
            db.close()

    result = await asyncio.to_thread(chat_fn)
    if result is None:
        # Sender not allowlisted. The chat_filter on the handler should also
        # reject these, but defense in depth.
        return
    raw, rendered = result
    try:
        await update.message.reply_text(rendered, parse_mode="HTML")
    except Exception as e:
        # If Telegram rejects our HTML (rare — escapes are conservative, but
        # a stray tag can slip through), retry as raw markdown rather than
        # dropping the response on the floor.
        print(f"telegram HTML send error: {e}; falling back to plain text")
        await update.message.reply_text(raw)


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Telegram sends multiple sizes; last entry = highest resolution.
    tg_file = await update.message.photo[-1].get_file()
    photo_bytes = await tg_file.download_as_bytearray()
    b64 = base64.b64encode(photo_bytes).decode("utf-8")
    data_uri = f"data:image/jpeg;base64,{b64}"
    await _respond(update, update.message.caption or "", image_url=data_uri)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _respond(update, update.message.text)


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    tg_file = await update.message.voice.get_file()

    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
        path = tmp.name

    try:
        await tg_file.download_to_drive(path)
        text = await asyncio.to_thread(llm_client.transcribe, path)
    finally:
        os.unlink(path)

    if not text.strip():
        await update.message.reply_text("Sorry, I couldn't transcribe that.")
        return

    await update.message.reply_text(f"[Voice] {text}")
    await _respond(update, text)


async def cmd_memory(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _respond(update, "/memory")


async def cmd_goals(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _respond(update, "/goals")


async def cmd_goal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    name = " ".join(context.args) if context.args else ""
    await _respond(update, f"/goal {name}")


DIGEST_REPLY_RE = re.compile(r"^\s*(done|tom|kill)((?:\s+\d+)+)\s*$", re.IGNORECASE)


async def handle_digest_reply(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle `done <n>...`, `tom <n>...`, `kill <n>...` replies to the daily
    digest. Indices are 1-based and refer to the most recent digest sent to
    this chat. Multiple indices supported in one message: `done 1 3`.

    Resolution lives in app.services.todo_nudge so WhatsApp can share it.
    """
    text = (update.message.text or "").strip()
    m = DIGEST_REPLY_RE.match(text)
    if not m:
        return  # filter should prevent this; defensive
    cmd = m.group(1).lower()
    indices = [int(p) for p in m.group(2).split()]
    chat_id = update.message.chat_id

    def run() -> str:
        db = SessionLocal()
        try:
            return resolve_digest_reply("telegram", str(chat_id), cmd, indices, db)
        finally:
            db.close()

    reply = await asyncio.to_thread(run)
    await update.message.reply_text(reply)


def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.")

    # Refuse to start without an allowlist — the bot costs OpenAI tokens per
    # message, and without a chat-ID filter anyone who finds the bot can run
    # up the bill + pollute the conversation DB. Opt-in override for local
    # testing: set ALLOW_UNFILTERED_TELEGRAM=1 (never use in prod).
    allowed_chat_ids = telegram_channel.allowed_chat_ids
    unfiltered_ok = os.getenv("ALLOW_UNFILTERED_TELEGRAM") == "1"
    if not allowed_chat_ids and not unfiltered_ok:
        raise ValueError(
            "TELEGRAM_CHAT_ID is not set. Set it to your personal Telegram chat ID "
            "(message @userinfobot to find yours; comma-separate multiple). "
            "To deliberately run without a filter in local dev, set "
            "ALLOW_UNFILTERED_TELEGRAM=1 — never do this in prod."
        )

    chat_filter = (
        filters.Chat(chat_id=allowed_chat_ids) if allowed_chat_ids else filters.ALL
    )

    async def _post_init(application):
        # Wire the bot handle into the channel singleton so proactive sends
        # (FastAPI lifespan nudge scheduler) can route through telegram_channel.send.
        telegram_channel.attach_bot(application.bot)

    app = ApplicationBuilder().token(token).post_init(_post_init).build()

    # Every handler is gated on chat_filter so messages from non-allowlisted
    # chats are dropped silently. CommandHandler takes the filter via kwarg;
    # MessageHandler via `&` composition with its content filter.
    app.add_handler(CommandHandler("memory", cmd_memory, filters=chat_filter))
    app.add_handler(CommandHandler("goals", cmd_goals, filters=chat_filter))
    app.add_handler(CommandHandler("goal", cmd_goal, filters=chat_filter))
    app.add_handler(MessageHandler(filters.PHOTO & chat_filter, handle_photo))
    # Digest reply (done/tom/kill <n>) — must come BEFORE the catch-all text
    # handler so it intercepts those messages before they hit the orchestrator.
    app.add_handler(MessageHandler(filters.Regex(DIGEST_REPLY_RE) & chat_filter, handle_digest_reply))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND & chat_filter, handle_message))
    app.add_handler(MessageHandler(filters.VOICE & chat_filter, handle_voice))

    if allowed_chat_ids:
        print(f"Gooni Telegram Bot started. Allowlisted chat IDs: {allowed_chat_ids}")
    else:
        print("Gooni Telegram Bot started in UNFILTERED mode (DEV ONLY).")
    app.run_polling()


if __name__ == "__main__":
    main()
