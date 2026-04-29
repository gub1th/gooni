import asyncio
import base64
import os
import re
import tempfile
from datetime import datetime, timedelta

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
from app.services.todo_nudge import build_nudge_message, seconds_until_next

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


# Maps chat_id -> ordered list of todo IDs as they appeared in that chat's
# most recent digest. Lets `done 2` resolve to a real todo without forcing
# the user to remember backend IDs. Lost on restart, which is fine — the
# next nudge repopulates it.
_last_digest: dict[int, list[int]] = {}

DIGEST_REPLY_RE = re.compile(r"^\s*(done|tom|kill)((?:\s+\d+)+)\s*$", re.IGNORECASE)


async def daily_nudge_loop(app, chat_ids: list[int]) -> None:
    """Sleep until the next NUDGE_HOUR:NUDGE_MINUTE local, then send the digest
    to every allowlisted chat. No-news days send nothing at all (build_nudge_message
    returns None). Loops forever; runs as a background task on the bot's event loop.
    """
    nudge_hour = int(os.getenv("NUDGE_HOUR", "9"))
    nudge_minute = int(os.getenv("NUDGE_MINUTE", "0"))

    while True:
        wait = seconds_until_next(nudge_hour, nudge_minute)
        try:
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            return

        try:
            db = SessionLocal()
            try:
                result = build_nudge_message(db)
            finally:
                db.close()
            if result:
                msg, ordered_ids = result
                for chat_id in chat_ids:
                    try:
                        await app.bot.send_message(chat_id=chat_id, text=msg)
                        _last_digest[chat_id] = ordered_ids
                    except Exception as e:
                        print(f"[nudge] send failed for {chat_id}: {e}")
        except Exception as e:
            print(f"[nudge] error: {e}")

        # Buffer past the firing minute so the loop doesn't immediately
        # recompute "next 9:00" as today again on a clock that's still 09:00:00.
        await asyncio.sleep(70)


async def handle_digest_reply(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle `done <n>...`, `tom <n>...`, `kill <n>...` replies to the daily
    digest. Indices are 1-based and refer to the most recent digest sent to
    this chat. Multiple indices supported in one message: `done 1 3`.
    """
    from app.db.models import ListItem  # local import keeps cold-start cheap

    text = (update.message.text or "").strip()
    m = DIGEST_REPLY_RE.match(text)
    if not m:
        return  # filter should prevent this; defensive
    cmd = m.group(1).lower()
    indices = [int(p) for p in m.group(2).split()]
    chat_id = update.message.chat_id

    ordered_ids = _last_digest.get(chat_id)
    if not ordered_ids:
        await update.message.reply_text(
            "no recent digest to act on — wait for tomorrow's ping (or set NUDGE_HOUR earlier)."
        )
        return

    db = SessionLocal()
    try:
        results: list[str] = []
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow = today + timedelta(days=1)

        for idx in indices:
            if idx < 1 or idx > len(ordered_ids):
                results.append(f"#{idx} out of range")
                continue
            tid = ordered_ids[idx - 1]
            t = db.query(ListItem).filter(ListItem.id == tid).first()
            if not t:
                results.append(f"#{idx} not found (deleted?)")
                continue
            if cmd == "done":
                if not t.done:
                    t.done = True
                    t.completed_at = datetime.utcnow()
                results.append(f"✓ {t.text}")
            elif cmd == "tom":
                t.due_date = tomorrow
                results.append(f"→ tomorrow: {t.text}")
            elif cmd == "kill":
                results.append(f"× {t.text}")
                db.delete(t)
        db.commit()
        await update.message.reply_text("\n".join(results) if results else "(no-op)")
    finally:
        db.close()


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

    nudge_enabled = os.getenv("NUDGE_ENABLED", "1") != "0"

    async def _post_init(application):
        # Wire the bot handle into the channel singleton so proactive sends
        # (currently unused; reserved for cross-channel nudge fan-out) can
        # route through telegram_channel.send.
        telegram_channel.attach_bot(application.bot)

        # Spawn the daily nudge once the loop is alive. Skip if no chat_ids —
        # we don't know who to ping in unfiltered dev mode, and silent dev is
        # better than fan-out spam.
        if nudge_enabled and allowed_chat_ids:
            asyncio.create_task(daily_nudge_loop(application, allowed_chat_ids))
            print(
                f"Daily nudge scheduled at {os.getenv('NUDGE_HOUR', '9')}:"
                f"{os.getenv('NUDGE_MINUTE', '00').zfill(2)} local"
            )

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
