from dotenv import load_dotenv

load_dotenv()

import asyncio
import os
import tempfile

from telegram import Update
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.db.database import SessionLocal
from app.llm.client import llm_client
from app.messaging.telegram_transport import TelegramTransport
from app.services.onboarding_service import onboarding_service
from app.services.orchestrator import Orchestrator
from app.services.scheduler import schedule_checkins, scheduler


# ---------------------------------------------------------------------------
# Scheduler lifecycle hooks
# ---------------------------------------------------------------------------

async def _post_init(app: Application) -> None:
    transport = TelegramTransport()
    user_chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if user_chat_id:
        schedule_checkins(transport, user_chat_id)
    if not scheduler.running:
        scheduler.start()


async def _post_shutdown(app: Application) -> None:
    if scheduler.running:
        scheduler.shutdown()


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def _respond(update: Update, message: str) -> None:
    """Pass message through orchestrator, reply, and handle onboarding completion."""

    def chat_fn():
        db = SessionLocal()
        try:
            was_complete = onboarding_service.is_complete(db)
            response, usage = Orchestrator.handle_chat(message, db)
            is_complete_now = onboarding_service.is_complete(db)
            return response, usage, was_complete, is_complete_now
        finally:
            db.close()

    response, usage, was_complete, is_complete_now = await asyncio.to_thread(chat_fn)

    await update.message.reply_text(response)

    # Onboarding just finished — wire up proactive check-ins
    if not was_complete and is_complete_now:
        transport = TelegramTransport()
        chat_id = str(update.effective_chat.id)
        schedule_checkins(transport, chat_id)

    if usage:
        tools_used = usage.get("tools_used", [])
        if tools_used:
            print(f"[tools] {', '.join(tools_used)}")
        mem = usage.get("memory", {})
        parts = []
        if mem.get("profile_updated"):
            parts.append(f"{mem['profile_updated']} profile updated")
        if mem.get("episodic_added"):
            parts.append(f"{mem['episodic_added']} episodic stored")
        if parts:
            print(f"[memory] {' · '.join(parts)}")


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


async def cmd_profile(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    def fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat("/profile", db)
        finally:
            db.close()

    response, _ = await asyncio.to_thread(fn)
    await update.message.reply_text(response)


async def cmd_episodic(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    def fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat("/episodic", db)
        finally:
            db.close()

    response, _ = await asyncio.to_thread(fn)
    await update.message.reply_text(response)


async def cmd_goals(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    def fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat("/goals", db)
        finally:
            db.close()

    response, _ = await asyncio.to_thread(fn)
    await update.message.reply_text(response)


def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.")

    app = (
        ApplicationBuilder()
        .token(token)
        .post_init(_post_init)
        .post_shutdown(_post_shutdown)
        .build()
    )

    app.add_handler(CommandHandler("profile", cmd_profile))
    app.add_handler(CommandHandler("episodic", cmd_episodic))
    app.add_handler(CommandHandler("goals", cmd_goals))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))

    print("Gooni Telegram Bot started. Press Ctrl+C to stop.")
    app.run_polling()


if __name__ == "__main__":
    main()
