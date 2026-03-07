# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About the Developer

Daniel is a young, eager software engineer actively learning. When working with him:
- **Explain terminal commands** — if a command has flags or non-obvious syntax, briefly explain what they do
- **Teach system design concepts** as they come up naturally in the code (e.g. why we use singletons, why CORS exists, what a message queue would buy us)
- Keep explanations concise but educational — don't just do the thing, say why it's done that way

## Project Overview

Gooni is a goals + accountability AI companion. It has:
- A **FastAPI backend** (port 8000) with chat, memory, goals, notes, and conversations
- A **React/Vite frontend** (port 5173) — notes editor with goal spaces and AI conversation threads
- An **OpenAI LLM** layer for chat responses and embeddings
- A **Telegram bot** for mobile input and proactive check-ins

## Architecture

### Backend (`app/`)

- **`app/main.py`** — FastAPI app. All routes registered here. CORS middleware allows frontend (5173) to call backend (8000).
- **`app/services/orchestrator.py`** — Central brain for Telegram/CLI chat. Exported as `Orchestrator` (singleton instance).
- **`app/services/goal_service.py`** — CRUD for goals, streak calculation, 7-day activity window
- **`app/services/note_service.py`** — Notes CRUD per goal or general
- **`app/services/conversation_service.py`** — Conversation + Message CRUD. Handles Telegram session grouping (Option C: 2hr gap + same calendar day = new session).
- **`app/services/memory_service.py`** — Vector-based long-term memory using cosine similarity + OpenAI embeddings
- **`app/llm/client.py`** — OpenAI wrapper. Instance: `llm_client`. Model: `gpt-4o-mini` (default), `gpt-4o` for vision
- **`app/db/models.py`** — SQLAlchemy models: `Note`, `Conversation`, `Message`, `Goal`, `UserProfileMemory`, `EpisodicMemory`, `Meal`, `Workout`, `WorkoutSet`
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/db/schemas.py`** — Pydantic request/response schemas

### Frontend (`frontend/src/`)

- **`routes/index.tsx`** — Main Notes page (`/`). Responsive 3-breakpoint layout. Auto-selects first goal on load.
- **`components/notes/Editor.tsx`** — Compose area + scrollable feed. ⌘↵ saves note, ⌘⇧↵ starts conversation.
- **`components/notes/Sidebar.tsx`** — Goal spaces list. `+` button to create new goal inline.
- **`services/api.ts`** — All `fetch()` calls to the backend. Single source of truth for API shape.
- **`stores/notesStore.ts`** — Zustand store for feed items and messages. Persist key: `gooni-notes-v4`.
- **`stores/useGoalsStore.ts`** — Goals list + create. Fetched once on mount.
- **`stores/useFeedStore.ts`** — General feed (cross-goal). Separate from per-goal feed.
- **`types/notes.ts`** — Core types: `Note`, `ConversationFeedItem`, `FeedItem` (union), `Message`
- **`hooks/useWindowWidth.ts`** — Returns live window width for responsive layout breakpoints

### Messaging Layer
- **`scripts/telegram_bot.py`** — Telegram bot entry point. Run with `PYTHONPATH=.`
- **`app/messaging/`** — Telegram and Twilio transports
- **`app/services/scheduler.py`** — APScheduler for proactive check-ins

## Running the App

### All at once (recommended)
```bash
./dev.sh   # kills stale ports, opens 4 iTerm2 tabs: backend, frontend, telegram, datasette
```

### Individually
```bash
# Backend
source venv/bin/activate
uvicorn app.main:app --reload

# Frontend
cd frontend && npm run dev

# Telegram bot
PYTHONPATH=. python scripts/telegram_bot.py

# Datasette (DB browser)
datasette db/gooni.db -p 8002
```

## Build & Validation

Always run these before considering frontend work done:

```bash
# TypeScript — must be zero errors
cd frontend && npx tsc --noEmit

# Python import check — catches broken imports fast
python -c "from app.main import app; print('OK')"
```

Full smoke test checklist:
1. `GET /goals` returns goals list
2. `GET /goals/1/feed` returns mixed notes + conversations
3. Web ⌘↵ → Note appears in feed
4. Web ⌘⇧↵ → Conversation appears, Claude's seed message visible
5. Telegram message → creates/reuses a Conversation, response returned

## API Endpoints

### Goals
- `GET /goals` — list goals with streak + 7-day activity
- `POST /goals` — create goal `{ title }`

### Notes
- `POST /goals/{id}/notes` — create goal note `{ content }`
- `POST /notes` — create general note `{ content }`
- `PATCH /notes/{id}` — update note `{ content }`

### Conversations
- `POST /goals/{id}/conversations` — create goal conversation `{ content }`
- `POST /conversations` — create general conversation `{ content }`
- `GET /conversations/{id}/messages` — list messages
- `POST /conversations/{id}/messages` — send message `{ content, goal_id, entry_content }`
- `POST /conversations/{id}/seed` — Claude opens unprompted `{ goal_id, entry_content }`

### Feed
- `GET /goals/{id}/feed` — notes + conversations for a goal, sorted by created_at desc
- `GET /feed` — general feed (no goal_id), notes + conversations

### Other
- `POST /chat` — direct chat `{ content, image_url? }`
- `GET /health` — health check

## Data Model

```
Note         { id, goal_id?, content, title?, outcome?, log_date?, created_at }
Conversation { id, goal_id?, title?, summary?, source, last_message_at, created_at }
Message      { id, conversation_id → conversations, role, content, created_at }
Goal         { id, title, goal_type, streak, last_7_days }
```

Feed endpoints add `"type": "note"` or `"type": "conversation"` in the serializer — it's NOT a DB column, it's set when building the response.

## Environment Variables

- `OPENAI_API_KEY` — required for LLM + embeddings
- `DATABASE_URL` — optional, defaults to `sqlite:///./db/gooni.db`
- `TELEGRAM_BOT_TOKEN` — required for Telegram bot

## Code Patterns

- **Singleton services**: each service file creates one instance at the bottom and exports it. Whole app shares one instance — efficient and avoids multiple DB connection pools.
- **FastAPI dependency injection**: `db: Session = Depends(get_db)` — FastAPI creates and closes a DB session per request automatically.
- **CORS**: frontend and backend run on different ports. The browser blocks cross-origin requests by default; `CORSMiddleware` tells it to allow them.
- **Discriminated union in frontend**: `FeedItem = Note | ConversationFeedItem` — the `type` field lets TypeScript narrow the type safely in `if (item.type === "conversation")` checks.
- **Zustand persist**: stores survive page refresh. If you change store shape, bump the persist key (e.g. `gooni-notes-v4` → `gooni-notes-v5`) to avoid stale state bugs.
- **React StrictMode**: kept intentionally — double-fires effects in dev to catch bugs. Never remove it; fix the root cause instead.
