#!/bin/bash
set -e

# Force line-buffered stdout/stderr for all Python processes in this container.
# Without this, background asyncio tasks (e.g. the memory watchdog and the
# backfill/nudge loops in app/main.py) hit Python's default block-buffering
# when stdout is a pipe — their print() output sits in a 4KB buffer that
# can take hours to flush, hiding the lines we wanted from `fly logs`.
# uvicorn force-unbuffers its own logger, but that doesn't help our background
# tasks. PYTHONUNBUFFERED=1 is the standard Docker fix.
export PYTHONUNBUFFERED=1

# Telegram bot — long polling, runs in background
python -m scripts.telegram_bot &

# FastAPI server — foreground so the container stays alive
exec uvicorn app.main:app --host 0.0.0.0 --port 8080
