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
3. Over time, Gooni builds a memory from your notes (stored in Mem0 cloud)

Telegram bot exists for mobile capture — messages become conversations in the DB.

## North Star
Evolving toward an ambient physical assistant — a device that knows you passively and proactively surfaces relevant context. Gooni is the brain. See `docs/VISION.md`.

## Rules
- **Lock the end goal before non-trivial work.** After 2–4 turns of design back-and-forth, before writing any code, pause and post the goal as an explicit checklist:

  ```
  Goal: <one sentence>
  In scope:
    - <bullet>
    - <bullet>
  Out of scope:
    - <bullet>
    - <bullet>
  Success = <how I'll know it's done>
  ```

  Wait for "yes" / revisions before coding. Skip only for trivial fixes (typo, one-line edit) where a wrong assumption costs <10 min to undo.
- Don't add new features without being asked
- Don't change the DB schema without flagging it
- Don't install new dependencies without asking first
- **Call `mcp__gooni__add_memory` after meaningful work or product discussions** — code changes, architectural decisions, feature ideas, design directions. Gooni should know what was built AND what Daniel is thinking about, even if he never told it directly

## Current Priorities
See **`docs/TODO.md`** for the full backlog. Top items:
- Deploy Telegram bot
- Spaces navigation in sidebar

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes + startup migrations. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note`, `Conversation`, `Message`, `Focus`, `PublicProfile`
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Mem0 cloud client. `_is_memorable()` pre-check (len >= 8) gates all API calls. `has_memories()` cached for process lifetime.
- **`app/services/orchestrator.py`** — Unified chat handler (web + Telegram). `Orchestrator` singleton.
- **`app/services/note_service.py`** — Embedding + space suggestion + related notes (OpenAI embeddings, cosine similarity).
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "chat"`.
- **`routes/public.tsx`** — Layout shell for `/public/*` (just renders `<Outlet />`).
- **`routes/public.index.tsx`** — Public portfolio list: Posts tab (space-filtered) + About tab (bio).
- **`routes/public.$noteId.tsx`** — Full public note detail page.
- **`components/notes/Sidebar.tsx`** — 200px. Two draggable sections (Notes / Chat), order persisted in localStorage. Notes section has: All Notes, collapsible Spaces list, recent notes. Chat section has: New Chat + recent conversations.
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px).
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s. `🌐 Public` toggle pill. Supports image drag/drop + paste (base64 inline). `hasChanges` ref prevents spurious saves on blur.
- **`components/ChatView.tsx`** — Full chat view when chat section is active.
- **`components/Dashboard.tsx`** — Stats, Focuses (committed/pending/someday), public bio editor.
- **`components/GooniPanel.tsx`** — Chat panel (300px). Passes active note as context.
- **`stores/useNotesContentStore.ts`** — Selected space, notes per space, active note, isDirty. Persist key: `gooni-notes-v1`.
- **`stores/useSpacesStore.ts`** — Space list from backend (includes General).
- **`stores/useConversationsStore.ts`** — Conversations list + active conversation.
- **`stores/useGooniStore.ts`** — GooniPanel open state. Persist key: `gooni-v1`.
- **`services/api.ts`** — All fetch calls. Key interfaces: `ApiNote`, `ApiSpace`, `PublicNote`, `PublicNoteDetail`.

### MCP Server (`mcp/server.py`)
Exposes Gooni to Claude Code via stdio. Tools:
- `get_context(query)` — semantic memory search
- `add_memory(content)` — store a memory
- `search_memories(query, limit)` — search memories
- `edit_memory(id, content)` — update a memory
- `forget_memory(id)` — delete a memory
- `add_note(title, content)` — create a note in General space
- `search_notes(query, limit)` — semantic note search
- `edit_note(note_id, title?, content?)` — update an existing note
- `list_spaces()` — list all spaces
- `list_notes(space_id, limit)` — browse notes in a space

## Running

```bash
./dev.sh   # recommended: kills stale ports, opens backend + frontend tabs

# Or individually:
source venv/bin/activate && uvicorn app.main:app --reload   # port 8000
cd frontend && npm run dev                                   # port 5173
python scripts/telegram_bot.py                              # Telegram bot
```

## Validation (run before every commit)

```bash
cd frontend && npx tsc --noEmit          # zero errors required
source venv/bin/activate && python -c "from app.main import app; print('OK')"
```

## Key API Endpoints

```
GET  /spaces                    → list spaces
POST /spaces                    → create space { name, emoji? }
PATCH /spaces/{id}              → update space { name?, emoji? }
DELETE /spaces/{id}             → delete space + its notes
GET  /spaces/{id}/notes         → notes for space (use "general" for all)
POST /spaces/{id}/notes         → create note
PATCH /notes/{id}               → update note { title?, content?, space_id?, is_public? }
DELETE /notes/{id}              → delete note
POST /notes/{id}/embed          → generate embedding + suggest space
POST /notes/{id}/touch          → update last_opened_at
POST /notes/{id}/memorize       → extract facts → Mem0
GET  /notes/{id}/related        → similar notes by embedding

GET  /public/notes              → public notes list { id, title, space_name, excerpt, updated_at }
GET  /public/notes/{id}         → full public note (404 if not public)
GET  /public/profile            → { bio: string | null }
PATCH /public/profile           → save bio { bio }

POST /chat                      → Gooni chat { content, entry_content?, model? }
GET  /feed                      → all conversations
GET  /conversations/{id}/messages
POST /conversations/{id}/messages → send message + get reply

GET  /dashboard                 → stats + focuses + gooni_take briefing
POST /focuses                   → create focus { name, commitment, due_date? }

GET  /debug/memories            → inspect stored Mem0 memories
```

## Code Patterns

- **Zustand persist**: if you change a store's shape, bump the persist key to avoid stale state (e.g. `v1` → `v2`)
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom — whole app shares it
- **FastAPI `db: Session = Depends(get_db)`** — session created/closed per request automatically
- **Startup migrations**: `_run_column_migrations()` in `main.py` runs ALTER TABLE for new columns on existing DBs
- **Optimistic UI**: `createNote` adds a temp note instantly, replaces with real API response
- **React StrictMode**: kept intentionally — double-fires effects in dev to expose bugs; never remove it
- **hasChanges ref**: NoteEditor only calls save() if user actually typed — prevents updated_at being touched on blur
- **Public routes**: `/public` and `/public/$noteId` are standalone pages (no sidebar, no auth)
- **Images in notes**: base64 data URLs stored inline in note content via TipTap Image extension

## Known Issues
