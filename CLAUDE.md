# CLAUDE.md

## About the Developer

Daniel is an eager software engineer actively learning. When working with him:
- **Explain terminal commands** — if a command has flags or non-obvious syntax, briefly say what they do
- **Teach concepts** as they come up naturally (why CORS exists, why singletons, etc.)
- Keep explanations concise but educational

## Goal

Gooni is a **personal AI notebook**. The core loop:
1. You write notes (structured like Apple Notes — spaces → notes list → editor)
2. Jarvis (GPT-4o-mini) reads your active note and answers questions / gives feedback
3. Over time, Jarvis builds a memory from your notes (episodes stored in SQLite)

Telegram bot exists for mobile capture — messages become notes/conversations in the DB.

See **TODO.md** for current priorities.

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note`, `Conversation`, `Message`, `Goal`, `Memory`, `Meal`, `Workout`, `WorkoutSet`
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Vector memory (cosine similarity + OpenAI embeddings). `create_episode()` saves note content as long-term memory.
- **`app/services/orchestrator.py`** — Handles Telegram/CLI chat. `Orchestrator` singleton.
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — 4-panel layout: Sidebar | NotesList | NoteEditor | JarvisPanel (optional)
- **`components/notes/Sidebar.tsx`** — Space list (200px). 💬 toggles Jarvis.
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px). + creates note.
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s.
- **`components/JarvisPanel.tsx`** — Chat panel (300px). Passes active note as context.
- **`stores/useNotesContentStore.ts`** — Single source of truth: selected space, notes per space, active note. Persist key: `gooni-notes-content-v1`.
- **`stores/useSpacesStore.ts`** — Space list from backend.
- **`stores/useJarvisStore.ts`** — Chat messages + `isOpen`. Persist key: `gooni-jarvis-v1`.
- **`services/api.ts`** — All fetch calls. Spaces, Notes, Jarvis only.

## Running

```bash
./dev.sh   # recommended: kills stale ports, opens backend + frontend tabs

# Or individually:
source venv/bin/activate && uvicorn app.main:app --reload   # port 8000
cd frontend && npm run dev                                   # port 5173
```

## Validation (run before every commit)

```bash
cd frontend && npx tsc --noEmit          # zero errors required
python -c "from app.main import app; print('OK')"
```

## Key API Endpoints

```
GET  /spaces               → list spaces
POST /spaces               → create space { name }
GET  /spaces/{id}/notes    → notes for space (sorted by updated_at desc)
POST /spaces/{id}/notes    → create note { title?, content? }
PATCH /notes/{id}          → update note { title?, content? }  (also saves memory episode)
DELETE /notes/{id}         → delete note
POST /chat                 → Jarvis chat { content, entry_content? }
GET  /debug/memories       → inspect stored memories
```

## Code Patterns

- **Zustand persist**: if you change a store's shape, bump the persist key to avoid stale state (e.g. `v1` → `v2`)
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom — whole app shares it
- **FastAPI `db: Session = Depends(get_db)`** — session created/closed per request automatically
- **Optimistic UI**: `createNote` adds a temp note instantly, replaces with real API response
- **React StrictMode**: kept intentionally — double-fires effects in dev to expose bugs; never remove it
