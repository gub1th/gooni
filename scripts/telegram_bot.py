import asyncio
import base64
import os
import tempfile

from dotenv import load_dotenv
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

load_dotenv()

Base.metadata.create_all(bind=engine)


async def _respond(update: Update, message: str, image_url: str | None = None) -> None:
    def chat_fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(message, db, image_url=image_url)
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
