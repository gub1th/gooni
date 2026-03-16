# CLAUDE.md

## About the Developer

Daniel is an eager software engineer actively learning. When working with him:
- **Explain terminal commands** — if a command has flags or non-obvious syntax, briefly say what they do
- **Teach concepts** as they come up naturally (why CORS exists, why singletons, etc.)
- Keep explanations concise but educational

## Goal

Gooni is a **personal AI notebook** evolving toward an ambient home assistant. The core loop:
1. You write notes (Apple Notes layout — spaces → notes list → editor)
2. Gooni (GPT-4o-mini) reads your active note and answers questions / gives feedback
3. Over time, Gooni builds a memory from your notes (stored in SQLite)

Telegram bot exists for mobile capture — messages become notes/conversations in the DB.

## North Star
Evolving toward an ambient physical assistant — a device that knows you passively and proactively surfaces relevant context. Gooni is the brain. See `docs/VISION.md`.

## Rules
- Don't add new features without being asked
- Don't change the DB schema without flagging it
- Don't install new dependencies without asking first

## Current Priorities
See **`docs/TODO.md`** for the full backlog. Top items:
- Deploy Telegram bot
- GoalView redesign (living document feel, inline note creation)
- Memory refactor (replace hardcoded meals/workouts with flexible Memory entities)

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes + startup migrations. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Goal`, `Note`, `Conversation`, `Message`, `Memory`, `Meal`, `Workout`, `WorkoutSet`
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Vector memory (cosine similarity + OpenAI embeddings).
- **`app/services/orchestrator.py`** — Unified chat handler (web + Telegram). `Orchestrator` singleton.
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "goal"`.
- **`components/notes/Sidebar.tsx`** — Goals section + Spaces section (200px).
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px).
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s. Goal chip in header.
- **`components/GoalView.tsx`** — Goal detail: title, motivation, milestones, linked notes, Gooni briefing.
- **`components/GooniPanel.tsx`** — Chat panel (300px). Passes active note as context.
- **`stores/useNotesContentStore.ts`** — Selected space, notes per space, active note. Persist key: `gooni-notes-v1`.
- **`stores/useSpacesStore.ts`** — Space list from backend.
- **`stores/useGoalsStore.ts`** — Goals list + selected goal from backend.
- **`stores/useGooniStore.ts`** — Chat messages + `isOpen`. Persist key: `gooni-v1`.
- **`services/api.ts`** — All fetch calls.

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
source venv/bin/activate && python -c "from app.main import app; print('OK')"
```

## Key API Endpoints

```
GET  /spaces                    → list spaces
POST /spaces                    → create space { name }
GET  /spaces/{id}/notes         → notes for space
POST /spaces/{id}/notes         → create note
PATCH /notes/{id}               → update note { title?, content?, space_id?, goal_id? }
DELETE /notes/{id}              → delete note
GET  /goals                     → list active goals (full data)
POST /goals                     → create goal { title, goal_type?, motivation? }
PATCH /goals/{id}               → update goal { title?, motivation?, status?, milestones? }
DELETE /goals/{id}              → delete goal (unlinks notes)
GET  /goals/{id}/notes          → notes linked to this goal
POST /chat                      → Gooni chat { content, entry_content? }
GET  /debug/memories            → inspect stored memories
```

## Code Patterns

- **Zustand persist**: if you change a store's shape, bump the persist key to avoid stale state (e.g. `v1` → `v2`)
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom — whole app shares it
- **FastAPI `db: Session = Depends(get_db)`** — session created/closed per request automatically
- **Startup migrations**: `_run_column_migrations()` in `main.py` runs ALTER TABLE for new columns on existing DBs
- **Optimistic UI**: `createNote` adds a temp note instantly, replaces with real API response
- **React StrictMode**: kept intentionally — double-fires effects in dev to expose bugs; never remove it
- **Component extraction**: sub-components with their own visual logic, state, or animation belong in separate files under `components/`. Inline sub-components are fine during early iteration but should be extracted once the shape stabilizes. A component file growing past ~200 lines is a signal to extract.

## Known Issues
