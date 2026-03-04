# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About the Developer

Daniel is a young, eager software engineer actively learning. When working with him:
- **Explain terminal commands** — if a command has flags or non-obvious syntax, briefly explain what they do
- **Teach system design concepts** as they come up naturally in the code (e.g. why we use singletons, why CORS exists, what a message queue would buy us)
- Keep explanations concise but educational — don't just do the thing, say why it's done that way

## Project Overview

Gooni is a goals + accountability AI companion. It has:
- A **FastAPI backend** (port 8000) with chat, memory, goals, and notes
- A **React/Vite frontend** (port 5173) that shows goals, streaks, and a feed
- An **OpenAI LLM** layer for chat responses and embeddings

## Architecture

### Backend (`app/`)

- **`app/main.py`** — FastAPI app. Registers all routes. Also adds CORS middleware so the frontend (on port 5173) can call the backend (on port 8000).
- **`app/services/orchestrator.py`** — Central brain. Routes incoming chat to the right services. Exported as `Orchestrator` (instance, not class).
- **`app/services/goal_service.py`** — CRUD for goals
- **`app/services/note_service.py`** — Notes per goal, streak calculation, 7-day activity window
- **`app/services/memory_service.py`** — Vector-based memory using cosine similarity + OpenAI embeddings
- **`app/llm/client.py`** — OpenAI wrapper. Instance: `llm_client`. Model: `gpt-4o-mini` (default), `gpt-4o` for vision
- **`app/db/models.py`** — SQLAlchemy models: Interaction, UserProfileMemory, EpisodicMemory, Todo, OnboardingState, Goal, Note
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`

### Frontend (`frontend/`)

- React + TypeScript, bundled with Vite
- `src/services/api.ts` — all fetch calls to the backend
- `src/routes/` — TanStack Router file-based routes
- `src/stores/` — Zustand state stores
- `src/components/` — UI components using Chakra UI

### Messaging Layer (secondary)
- `app/messaging/` — Telegram and Twilio transports for proactive outbound messages
- `scripts/telegram_bot.py` — Telegram bot entry point
- `app/services/scheduler.py` — APScheduler for check-ins

## Running the App

### Backend
```bash
source venv/bin/activate   # activate Python virtual environment
uvicorn app.main:app --reload  # --reload means it restarts on code changes
```
Backend available at http://localhost:8000. Docs at http://localhost:8000/docs.

### Frontend
```bash
cd frontend
npm run dev   # starts Vite dev server
```
Frontend available at http://localhost:5173.

### Both together
Run each in a separate terminal tab.

## API Endpoints

- `POST /chat` — send message, get AI response
- `GET /goals` — list active goals with streak + 7-day activity
- `GET /feed` — recent notes across all goals
- `GET /interactions` — conversation history
- `GET /memories` — stored memories
- `GET /health` — health check

## Environment Variables

- `OPENAI_API_KEY` — required for LLM + embeddings
- `DATABASE_URL` — optional, defaults to `sqlite:///./db/gooni.db`

## Code Patterns

- **Singleton services**: each service file creates one instance at the bottom and exports it. This means the whole app shares one instance (one DB connection pool, one cache, etc.) — efficient and simple.
- **FastAPI dependency injection**: `db: Session = Depends(get_db)` — FastAPI automatically creates and closes a DB session per request.
- **CORS**: needed because frontend and backend run on different ports. The browser blocks cross-origin requests by default; the middleware tells it to allow them.
