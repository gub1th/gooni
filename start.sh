#!/bin/bash
set -e

# Telegram bot — long polling, runs in background
python scripts/telegram_bot.py &

# FastAPI server — foreground so the container stays alive
exec uvicorn app.main:app --host 0.0.0.0 --port 8080
