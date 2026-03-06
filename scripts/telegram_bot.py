from dotenv import load_dotenv

load_dotenv()

import asyncio
import base64
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

from app.db.database import SessionLocal, engine
from app.db.models import Base
from app.llm.client import llm_client
from app.services.orchestrator import Orchestrator

Base.metadata.create_all(bind=engine)


async def _respond(update: Update, message: str) -> None:
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
        if mem.get("memories_saved"):
            parts.append(f"{mem['memories_saved']} memories")
        if mem.get("note_saved"):
            parts.append("note logged")
        if parts:
            print(f"[memory] {' · '.join(parts)}")


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Get highest-resolution photo (Telegram sends multiple sizes; last = largest)
    tg_file = await update.message.photo[-1].get_file()
    photo_bytes = await tg_file.download_as_bytearray()
    b64 = base64.b64encode(photo_bytes).decode("utf-8")
    data_uri = f"data:image/jpeg;base64,{b64}"

    caption = update.message.caption or ""

    def chat_fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(caption, db, image_url=data_uri)
        finally:
            db.close()

    response, usage = await asyncio.to_thread(chat_fn)
    await update.message.reply_text(response)

    if usage:
        tools_used = usage.get("tools_used", [])
        if tools_used:
            print(f"[tools] {', '.join(tools_used)}")


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
    def fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat("/memory", db)
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


async def cmd_goal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    name = " ".join(context.args) if context.args else ""

    def fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(f"/goal {name}", db)
        finally:
            db.close()

    response, _ = await asyncio.to_thread(fn)
    await update.message.reply_text(response)


def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.")

    app = ApplicationBuilder().token(token).build()

    app.add_handler(CommandHandler("memory", cmd_memory))
    app.add_handler(CommandHandler("goals", cmd_goals))
    app.add_handler(CommandHandler("goal", cmd_goal))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))

    print("Gooni Telegram Bot started. Press Ctrl+C to stop.")
    app.run_polling()


if __name__ == "__main__":
    main()
