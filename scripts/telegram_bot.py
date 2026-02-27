from dotenv import load_dotenv

load_dotenv()

import asyncio
import os
import tempfile

from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.db.database import SessionLocal
from app.llm.client import llm_client
from app.services.orchestrator import Orchestrator
from app.services.todo_service import todo_service


async def _respond(update: Update, message: str) -> None:
    """Pass message through orchestrator and reply."""
    def chat_fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(message, db)
        finally:
            db.close()

    response, usage = await asyncio.to_thread(chat_fn)

    await update.message.reply_text(response)

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


async def cmd_todos(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    def fn():
        db = SessionLocal()
        try:
            return todo_service.list_open(db)
        finally:
            db.close()

    todos = await asyncio.to_thread(fn)
    if not todos:
        await update.message.reply_text("No open todos!")
        return

    lines = ["Open todos:"]
    for t in todos:
        lines.append(f"  #{t.id} {t.content}")
    await update.message.reply_text("\n".join(lines))


def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.")

    app = ApplicationBuilder().token(token).build()

    app.add_handler(CommandHandler("profile", cmd_profile))
    app.add_handler(CommandHandler("episodic", cmd_episodic))
    app.add_handler(CommandHandler("todos", cmd_todos))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))

    print("Gooni Telegram Bot started. Press Ctrl+C to stop.")
    app.run_polling()


if __name__ == "__main__":
    main()
