# Gooni

Personal AI accountability companion with persistent memory, goals tracking, and a notes-first UI.

---

## Quick start (all processes)

```bash
./dev.sh
```

Opens a new iTerm2 window with four tabs — backend, frontend, Telegram bot, and Datasette — each running automatically.

---

## Running processes individually

### Backend
```bash
source venv/bin/activate
uvicorn app.main:app --reload
```
Runs at http://localhost:8000. Auto-reloads on file changes.
API docs at http://localhost:8000/docs.

**To restart:** `Ctrl+C` in the backend tab, then run the command again.

### Frontend
```bash
cd frontend
npm run dev
```
Runs at http://localhost:5173.

### Telegram bot
```bash
source venv/bin/activate
PYTHONPATH=. python scripts/telegram_bot.py
```

### Datasette (DB browser)
```bash
source venv/bin/activate
datasette db/gooni.db -p 8002
```
Runs at http://localhost:8002. Browse and query the SQLite DB visually.

---

## First-time setup

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd frontend && npm install && cd ..

cp .env.example .env
# Fill in OPENAI_API_KEY and TELEGRAM_BOT_TOKEN in .env
```

### Reset the database
```bash
rm db/gooni.db
# Restart the backend — it recreates all tables automatically on startup
```

---

## Architecture

```
app/
  main.py                    # FastAPI routes
  db/
    models.py                # SQLAlchemy models (Goal, Note, Conversation, Message, Memory)
    schemas.py               # Pydantic request models
  services/
    orchestrator.py          # Central chat handler (Telegram entry point)
    goal_service.py          # Goal CRUD
    note_service.py          # Note CRUD + streak / 7-day activity
    conversation_service.py  # Conversation sessions + message threads
    memory_service.py        # Vector memory (profile facts + episodes)
  llm/
    client.py                # OpenAI wrapper (gpt-4o-mini / gpt-4o for vision)

frontend/
  src/
    routes/index.tsx         # Main Notes UI (Sidebar + Editor)
    components/notes/
      Sidebar.tsx            # Goal-backed spaces list
      Editor.tsx             # Compose area + feed
    stores/
      notesStore.ts          # Feed, messages, UI state
      useGoalsStore.ts       # Goals with streak data
    services/api.ts          # All fetch calls to the backend

scripts/
  telegram_bot.py            # Telegram bot entry point
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Chat responses and embeddings |
| `TELEGRAM_BOT_TOKEN` | Yes (for bot) | Telegram bot token |
| `DATABASE_URL` | No | Defaults to `sqlite:///./db/gooni.db` |
