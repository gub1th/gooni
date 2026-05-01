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
3. Over time, Gooni builds a memory from your notes (stored locally in the SQLite `memories` table — extract → reconcile pipeline driven by LLM, retrieved by cosine similarity at chat time)

Bots for mobile capture (Telegram, WhatsApp, iMessage planned). Each routes through the unified `MessagingChannel` abstraction in `app/services/messaging/`.

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
- **Keep the docs honest.** When you change architecture, deps, env vars, or routes, update CLAUDE.md and README.md in the same PR. Stale docs poison every future session — outdated CLAUDE.md is worse than no CLAUDE.md. Focus on the high-leverage docs (CLAUDE.md > README.md > inline service docstrings); skip churn-prone files (TODO.md, VISION.md). If a section in CLAUDE.md describes something that's no longer true, fix it as part of the change that broke it, not as cleanup later.
- **Verify understanding before pushing.** Before `git push` on any non-trivial PR, pause. Recap in 3–6 lines: what changed, why it works, and one non-obvious thing Daniel should be able to explain back (e.g. "why the WABA needs a separate subscribe call beyond the field toggle"). Wait for "got it" or follow-up questions. Don't push while he's still piecing things together — the goal is shipping product *and* understanding, not just shipping. Skip the recap only on truly trivial work (typo, one-line edit, dependency bump). If he asks a clarifying question, answer it tightly and re-confirm before pushing.
- **One-line takeaway per merged PR.** After a PR merges (or is about to merge), ask Daniel for a single sentence: "what did you learn shipping this?" Then write it to a Gooni note via `mcp__gooni__add_note` (or `add_memory` if it's more durable than note-shaped) — title format `"PR #N takeaway: <topic>"`, body = his sentence + a one-line link/context for future-him. This builds a searchable arc of learning across the project without slowing the loop. Skip if the PR is pure plumbing (typo, version bump) or if Daniel says "skip."

## Current Priorities
See **`docs/TODO.md`** for the full backlog (gitignored — local only).

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes + startup migrations. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note`, `Conversation`, `Message`, `Memory`, `List`, `ListItem`, `PublicProfile`, `Visit`, `OAuthToken`, `TrackedRepo`, `EvalSegment`, `EvalStepFeedback`
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Local SQL-backed memory store (the `memories` table). Per chat exchange: `extract_candidates` (LLM) → cosine-search similar active memories → `reconcile_candidate` (LLM, ADD/UPDATE/DELETE/NONE) → apply. Retrieval injects always-included preferences plus top-5 facts/episodes by cosine similarity. Replaced the old Mem0 hosted service; legacy callers still see `{id, memory, ...}` dict shape via `_serialize`.
- **`app/services/orchestrator.py`** — Unified chat handler across all surfaces (web, telegram, whatsapp, imessage). `Orchestrator` singleton. Source defaults to `"web"`; bot channels share a single persistent conversation per source (no gap-based sessioning). Each turn builds a structured trace via `TraceBuilder` and stamps it on `Message.trace`.
- **`app/services/trace_builder.py`** — `TraceBuilder` helper + `PROMPT_VERSION` constant. Single source of truth for the per-turn trace shape: `{key, label, input, output, meta}` per step plus a leading `pipeline_version` step. Bump `PROMPT_VERSION` when you change orchestrator flow / master prompt assembly / memory pipeline so eval ratings can be filtered by pipeline iteration. Backward-compat aliases (`type`, `detail`, `args`) keep the existing chat MessageBubble rendering until it migrates.
- **`app/services/eval_service.py`** — Eval loop for chat replies. Segments conversations (web = 1 conv = 1 segment; bot threads sliced by `EVAL_GAP_HOURS`, default 4). CRUD for `EvalSegment` + `EvalStepFeedback`. Dispatches finished evals to a Claude Code space note + a backlog list item (idempotent on re-dispatch — overwrites the prior note rather than spawning duplicates). Static `TOOL_LEGEND` seeds the ⓘ legend popup in the eval UI.
- **`app/services/feedback_detector.py`** — Natural-language feedback detector (regex pre-filter + gpt-4o-mini classifier). Used by the orchestrator + eval surfaces to identify follow-up messages that critique a prior assistant reply.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound` pipeline. Per-channel impls: `telegram.py`, `whatsapp.py`, `imessage.py`. Each owns its outbound formatter (markdown → channel-native), allowlist, and send client. Webhook routes in `app/main.py` call `dispatch_inbound(channel, sender, text, db)` → orchestrator → channel-specific reply.
- **`app/services/note_service.py`** — Embedding + space suggestion + related notes (OpenAI embeddings, cosine similarity).
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "chat" | "lists" | "plan" | "eval"`.
- **`components/eval/EvalView.tsx`** — Eval tab. Grid of conversation segments (Google Docs-style cards) w/ per-source border + badge (web/telegram/whatsapp/imessage), filters (source, status, has-flag, search), and detail view per segment. Detail view: transcript + per-message trace cards (intent / memory_recall / master_prompt / extracted_signals / memories_applied / tool_call / reply), red-flag popover per step (1/2/3 + comment), overall summary editor, ⓘ tool-legend popup, and a "Dispatch to Claude Code" button that bundles the eval into a `Claude Code` space note plus a backlog list item.
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
- `find_note(match, limit)` — substring scan over recent notes; returns id + title preview
- `delete_note(note_id)` — irreversible; pre-fetches title for audit
- `list_spaces()` — list all spaces
- `list_notes(space_id, limit)` — browse notes in a space
- `read_list(list_ref="backlog", limit, include_done)` — read items from any list. Resolves by type ("backlog"/"todo"/"focus") → name → numeric id, so callers don't hard-code shifting ids.
- `add_list_item(text, list_ref="backlog", subtitle?)` — add to a list
- `check_list_item(match, list_ref="backlog", done=True)` — toggle done by text match (first-hit-wins)
- `delete_list_item(match, list_ref="backlog")` — delete by text match; refuses ambiguous matches

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
POST /notes/{id}/memorize       → extract facts → memory store
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

GET  /debug/memories            → inspect stored memories
POST /webhooks/whatsapp         → Meta Cloud API webhook (HMAC-verified)
GET  /webhooks/whatsapp         → Meta verify-token handshake
POST /webhooks/imessage         → BlueBubbles bridge webhook (X-Secret header)

GET  /settings                  → daily nudge config (hour/min/tz/channels/enabled)
PATCH /settings                 → update any subset of nudge_* fields
POST /settings/test-nudge       → fire the digest immediately (bypasses idempotency)

GET  /items                     → focus + inbox tree (now includes status, scale per node)
POST /items                     → create item; accepts status, scale, is_primary in body
PATCH /items/{id}               → patches now accept status + scale; status syncs `committed`
GET  /items/suggest-focus       → LLM proposes one new focus { text, endgoal?, scale? }
```

### Focus model fields

`list_items` rows representing focuses now carry:
- `status: 'committed' | 'pending' | 'someday' | null` — engagement state. NULL on legacy rows; UI derives from `committed`. `committed`/`pending` both keep `committed=True`; `someday` flips it false.
- `scale: 'long_term' | 'sprint' | 'medium' | null` — informational time horizon, drives a small badge.
- `is_primary` (existing) — singleton; only one item across the whole `list_items` table can be `True`. The dashboard's focuses list pulls primary to the top with a green left rail + tint + pulsing dot.

### Daily nudge

Morning digest of overdue + due-today todos lives in `app/services/todo_nudge.py`.
The scheduler runs in the FastAPI **lifespan** (not the Telegram bot script) so
config + idempotency can be DB-backed and survive bot restarts. zoneinfo-aware
fire time per `Settings.nudge_tz`. `Settings.nudge_last_sent_day` is the
idempotency token — kills double-send if Fly scales to 2 machines.

WhatsApp fan-out respects Meta's 24h customer-window: if no inbound WA message
in the last 24h, nudge skips that channel for the day. Telegram has no such
constraint and fires regardless.

Reply commands (`done <n>`, `tom <n>`, `kill <n>`) are persisted in
`Settings.nudge_last_digests` (JSON) so the Telegram bot polling process can
resolve replies that were sent by the FastAPI process.

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
