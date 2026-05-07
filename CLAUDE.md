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

- **Check off Gooni Backlog items as you ship them.** When a backlog item lands (commit pushed, work is in), call `mcp__gooni__check_list_item` with a distinctive substring of the item's text — don't wait for PR merge, don't batch at session end. The goal is "did this ship or not?" being answerable at a glance from the backlog, not by reading commit history. Match against the most unique phrase in the item title. If a single PR closes multiple backlog items (common for bundled UX work), check off each one individually. If you're catching up after forgetting mid-flight, batch the check-offs in parallel — but the default is check-as-you-ship.

- **Backlog ticket lifecycle (Jira-board flow).** Every non-trivial task lives on the backlog board. Work begins by claiming a ticket, ends by marking it Done with a PR link. Specifically:
  1. **Before you start coding**: search the backlog for an existing ticket that matches the work (`mcp__gooni__find_similar_items` with the task description; threshold 0.78). If one exists, flip its `board_status` to `in_progress` via `PATCH /list-items/{id}` body `{"board_status": "in_progress"}`. If none exists, create one via `mcp__gooni__add_list_item` first, then flip it.
  2. **While working**: ticket stays `in_progress`. If scope shifts mid-flight, edit the ticket text/subtitle to match (don't open a second one).
  3. **On PR merge** (or when the work is otherwise live): set the ticket to Done **and** paste the PR URL into `pr_url`: `PATCH /list-items/{id} {"board_status": "done", "pr_url": "https://github.com/.../pull/N"}`. The board column flips and the card surfaces a clickable PR pill.
  4. **One ticket per PR** is the default. Bundled PRs that close several tickets get N sequential PATCH calls — same `pr_url` on each.
  Skip this whole flow only for truly trivial fixes (typo, version bump, one-line edit) where the ceremony costs more than the tracking is worth.

## Current Priorities
See **`docs/TODO.md`** for the full backlog (gitignored — local only).

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes + startup migrations. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note` (carries `is_pinned` + `is_draft` + `is_public`), `Conversation`, `Message`, `Memory`, `List`, `ListItem` (carries `board_status` + `pr_url` for the Jira-style backlog board), `FocusTodoLink` (M2M between focus list_items and todo list_items — one todo can serve multiple focuses), `PublicProfile`, `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall` (append-only log of MCP-tagged HTTP requests; powers the dashboard "claude activity" stat), `ClaudeUsageTurn` (one row per Claude Code assistant turn, ingested by `scripts/upload_claude_usage.py`; UNIQUE on `session_id, ts`), `EvalSegment`, `EvalStepFeedback`, `WhoopSnapshot` (one row per day; cached recovery/HRV/RHR/strain/sleep pull served by `/whoop/today`)
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
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "chat" | "lists" | "plan" | "eval" | "stats"`. Top-right pair of icon buttons (Globe = public profile, Plug = MCP) lives here, fixed-position, visible on every view.
- **`components/eval/EvalView.tsx`** — Eval tab. Grid of conversation segments (Google Docs-style cards) w/ per-source border + badge (web/telegram/whatsapp/imessage), filters (source, status, has-flag, search), and detail view per segment. Detail view: transcript + per-message trace cards (intent / memory_recall / master_prompt / extracted_signals / memories_applied / tool_call / reply), red-flag popover per step (1/2/3 + comment), overall summary editor, ⓘ tool-legend popup, and a "Dispatch to Claude Code" button that bundles the eval into a `Claude Code` space note plus a backlog list item.
- **`routes/public.tsx`** — Layout shell for `/public/*` (just renders `<Outlet />`).
- **`routes/public.index.tsx`** — Public portfolio list: Posts tab (space-filtered) + About tab (bio).
- **`routes/public.$noteId.tsx`** — Full public note detail page.
- **`components/notes/Sidebar.tsx`** — 200px. Two draggable sections (Notes / Chat), order persisted in localStorage. Notes section has: All Notes, collapsible Spaces list, recent notes. Chat section has: New Chat + recent conversations.
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px).
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s. `🌐 Public` toggle pill. Supports image drag/drop + paste (base64 inline). `hasChanges` ref prevents spurious saves on blur.
- **`components/ChatView.tsx`** — Full chat view when chat section is active. Uses `chat/InputBar` (Gemini-style: + popup → upload image, model selector, mic for Web-Speech-API voice-to-text, send). Image attachments flow as base64 data URL via `image_url` to `/conversations/{id}/messages`.
- **`components/Dashboard.tsx`** — Greeting + 3 stat cards (notes-this-week, day streak, claude activity) + thin "Stats →" card linking to the stats view. Focuses (committed/pending/someday). Public bio editor lives on `/public`, not the dashboard.
- **`components/StatsView.tsx`** — Sidebar entry "Stats". Sections: OpenAI usage (live month-to-date from Admin API), Claude Code usage, **Whoop today** (recovery ring + HRV/RHR/strain + sleep block; only renders when Whoop is connected), Dev activity (streak + Gooni's Take + per-repo recent commits, all inline), Activity (notes/messages/conversations/todos counters).
- **`components/SettingsModal.tsx`** — Tabbed modal: Appearance (theme + face), Notifications (daily nudge), Integrations (Google Calendar + GitHub + Whoop w/ real logos — connect/disconnect only, live data lives in StatsView), Deployments (Fly + Vercel health pings). Version always shown in the tab sidebar header.
- **`components/FocusOverlay.tsx`** — Distraction-free overlay surfaced from the primary focus row's "focus" pill. Blurs the page, shows meditating Gooni, fades chrome on idle, exits via X / Esc.
- **`components/QuickNav.tsx`** — Cmd+K command palette mounted in `__root.tsx`. Jumps to home / lists / memories / audit / stats / public / mcp from any view.
- **`components/QuickComposer.tsx`** — Cmd+E quick-capture composer mounted in `__root.tsx`. Body-only TipTap modal (StarterKit + Image), saves to General via `apiCreateNote`, dispatches `gooni:note-created` window event so any mounted Dashboard re-pulls stats. Submit on Cmd+↵, newline on ⇧↵, esc / click-outside to close.
- **`components/GooniPanel.tsx`** — Chat panel (300px). Passes active note as context.
- **`stores/useNotesContentStore.ts`** — Selected space, notes per space, active note, isDirty. Persist key: `gooni-notes-v1`.
- **`stores/useSpacesStore.ts`** — Space list from backend (includes General).
- **`stores/useConversationsStore.ts`** — Conversations list + active conversation. `send()` accepts `imageUrl` for chat-input image attachments.
- **`stores/useGooniStore.ts`** — GooniPanel open state. Persist key: `gooni-v1`.
- **`stores/useGooniThemeStore.ts`** — Themes: `cool|warm|mint|rose|slate|dark`. `routes/__root.tsx` syncs the selected palette to CSS custom properties (`--gooni-bg`, `--gooni-text`, etc.) so migrated components render theme-aware via `var()` w/ light fallbacks. Non-migrated surfaces stay light under dark mode until incrementally migrated.
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
- `add_list_item(text, list_ref="backlog", subtitle?, skip_conflict_check=False)` — add to a list. Cosine-checks against existing items; near-duplicates surface as `conflicts: [{id, text, similarity, severity}]` in the response so the caller (or user) can merge instead of stacking dupes. Pass `skip_conflict_check=True` for bulk imports.
- `find_similar_items(text, list_ref="backlog", threshold=0.78, limit=5)` — read-only similarity search over a list, no insert. Use before adding to confirm an idea doesn't already exist.
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
GET  /dashboard/stats           → extended counters (notes/messages/conversations/todos this-week + total)
GET  /dashboard/openai-usage    → live month-to-date OpenAI usage from Admin API (configured? spend, requests, tokens, by-model breakdown). Requires OPENAI_ADMIN_KEY (sk-admin-…).
GET  /dashboard/claude-usage    → Claude Code usage. Source = local jsonls if `~/.claude/projects` exists (dev laptop), else `claude_usage_turns` DB rows (prod). Returns `available: bool` — frontend hides the section entirely when false (fresh prod box, no upload yet).
POST /dashboard/claude-usage/ingest → append-only ingest of {turns: [{session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}]}. Idempotent via UNIQUE(session_id, ts). Called by `scripts/upload_claude_usage.py` from the laptop.
POST /focuses                   → create focus { name, commitment, due_date? }

GET  /debug/memories            → inspect stored memories
POST /webhooks/whatsapp         → Meta Cloud API webhook (HMAC-verified)
GET  /webhooks/whatsapp         → Meta verify-token handshake
POST /webhooks/imessage         → BlueBubbles bridge webhook (X-Secret header)

GET  /settings                       → daily digest config (hour/min/tz/channels/enabled + nudge_prompt)
PATCH /settings                      → update any subset of nudge_* fields, including nudge_prompt
GET  /settings/nudge-prompt-default  → bundled default LLM instruction (used by the "Use default" button)
POST /settings/test-nudge            → fire the digest immediately (bypasses idempotency)

GET  /items                     → focus + inbox tree (now includes status, scale per node)
POST /items                     → create item; accepts status, scale, is_primary in body
PATCH /items/{id}               → patches now accept status + scale; status syncs `committed`
GET  /items/suggest-focus       → LLM proposes one new focus { text, endgoal?, scale? }

POST /lists/{id}/items          → add item; response includes `conflicts: [{id, text, similarity, severity}]` for near-duplicates already in the list. Pass `skip_conflict_check: true` to bypass the embed scan.
POST /lists/{id}/similar        → cosine-search a list { text, threshold?, limit?, include_done?, exclude_item_id? } → { matches: [{id, text, similarity}] }. Read-only.
```

### Focus model fields

`list_items` rows representing focuses now carry:
- `status: 'committed' | 'pending' | 'someday' | null` — engagement state. NULL on legacy rows; UI derives from `committed`. `committed`/`pending` both keep `committed=True`; `someday` flips it false.
- `scale: 'long_term' | 'sprint' | 'medium' | null` — informational time horizon, drives a small badge.
- `is_primary` (existing) — singleton; only one item across the whole `list_items` table can be `True`. The dashboard's focuses list pulls primary to the top with a green left rail + tint + pulsing dot.

### Daily digest

Daily digest message lives in `app/services/todo_nudge.py`. Single-call
shape: `compose_message(db) -> str | None`. Daniel writes the LLM
instruction in `Settings.nudge_prompt` (Settings → Notifications → Prompt
textarea) and the service injects a structured block of today's overdue +
due-today todos + active focuses after his prompt before calling the LLM.
Empty `nudge_prompt` falls back to `todo_nudge.DEFAULT_PROMPT`.

The scheduler runs in the FastAPI **lifespan** (not the Telegram bot script)
so config + idempotency can be DB-backed and survive bot restarts. Fire time
is zoneinfo-aware via `Settings.nudge_tz`; `Settings.nudge_last_sent_day` is
the YYYY-MM-DD idempotency token that kills double-send if Fly scales to 2.

WhatsApp fan-out respects Meta's 24h customer-window: if no inbound WA
message in the last 24h, nudge skips that channel for the day. Telegram has
no such constraint and fires regardless.

The old indexed-list format + `done <n>` / `tom <n>` / `kill <n>` reply
commands were removed — message arrives as a single conversational chat
message and Daniel just talks back to Gooni normally if he wants to act on it.

### Focus ↔ Todo links

`focus_todo_links` is a many-to-many between focuses and leaf todos, both
stored in `list_items` (focus = parent_id null + endgoal set; todo = leaf in
the Todo list). Endpoints:

- `POST /items/{focus_id}/derive-todo` — create a leaf todo + link in one
  shot. Body `{text, due_date?}`. Returns `{todo, link_id}`.
- `POST /items/{focus_id}/link-todo/{todo_id}` — attach an existing todo to
  a focus. Idempotent.
- `GET  /items/{focus_id}/todos` — todos linked to a focus.
- `GET  /items/{todo_id}/focuses` — focuses linked to a todo.
- `GET  /items/today-todos` — open todos due today, each row includes a
  `focuses: [{id, text, is_primary}]` chip array. Powers the dashboard's
  "Today's todos" section that replaced the legacy "Quick · today" focus
  column in `FocusFlow`.
- `DELETE /focus-todo-links/{link_id}` — sever a single link.

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
