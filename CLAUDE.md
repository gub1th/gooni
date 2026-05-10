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
  1. **Before you start coding**: search the backlog for an existing ticket that matches the work (`mcp__gooni__find_similar_items` with the task description; threshold 0.78). If one exists, flip its `board_status` to `doing` via `PATCH /backlog/tickets/{id}` body `{"board_status": "doing"}`. If none exists, create one via `mcp__gooni__add_list_item` first, then flip it. (Vocab note: the dashboard-revamp migration remapped legacy `'todo'`/`'in_progress'` values to `'not_yet'`/`'doing'` — use the new vocab when calling REST directly.)
  2. **While working**: ticket stays `doing`. If scope shifts mid-flight, edit the ticket text/subtitle to match (don't open a second one).
  3. **On PR merge** (or when the work is otherwise live): set the ticket to Done **and** paste the PR URL into `pr_url`: `PATCH /backlog/tickets/{id} {"board_status": "done", "pr_url": "https://github.com/.../pull/N"}`. The board column flips and the card surfaces a clickable PR pill.
  4. **One ticket per PR** is the default. Bundled PRs that close several tickets get N sequential PATCH calls — same `pr_url` on each.
  Skip this whole flow only for truly trivial fixes (typo, version bump, one-line edit) where the ceremony costs more than the tracking is worth.

## Current Priorities
See **`docs/TODO.md`** for the full backlog (gitignored — local only).

## Architecture

### Backend (`app/`)
- **`app/main.py`** — All FastAPI routes + startup migrations. CORS allows `localhost:5173`.
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note` (carries `is_pinned` + `is_draft` + `is_public` + `excerpt` (cached plain-text preview, stripped of HTML/`<img>`, capped at 240 chars — populated on every save, lazy-backfilled at startup so list endpoints don't ship full bodies)), `Conversation`, `Message`, `Memory`, `List`, `ListItem` (generic list rows only — text/subtitle/done/sort_order; focus / todo / backlog fields all moved to dedicated tables in the focus/todo/backlog extraction), `Focus` (long-running commitments — endgoal/health/confidence/scale/status/start_at/end_at/committed/`color`; auto-assigned 10-color palette dot for the dashboard. **Post-revamp:** `is_primary` moved to Todo; the M2M `focus_todo_links` table is gone — todos link via single FK), `Todo` (actionable item; carries `state` enum ('not_yet' | 'doing' | 'done' — synced w/ legacy `done` bool), `focus_id` single-FK to its parent focus, `is_primary` singleton (only one Todo across the table can be True; auto-cleared on completion)), `BacklogTicket` (engineering backlog ticket with board_status + pr_url + `todo_id` (FK set when promoted into a Todo via `/backlog/tickets/{id}/promote`); `board_status` vocab is `'not_yet' | 'doing' | 'done'` post-revamp (was `'todo' | 'in_progress' | 'done'` — migrated)), `PublicProfile` (carries `bio` + `avatar_url` — uploaded avatar URL via R2; NULL falls back to a deterministic goofy-emoji avatar in NoteComments), `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall` (append-only log of MCP-tagged HTTP requests; powers the dashboard "claude activity" stat), `ClaudeUsageTurn` (one row per Claude Code assistant turn, ingested by `scripts/upload_claude_usage.py`; UNIQUE on `session_id, ts`), `EvalSegment`, `EvalStepFeedback`, `EvalMessageRating` (per-assistant-message thumbs — 1=bad/2=meh/3=good with optional comment, UNIQUE on `message_id`; complements step-level feedback + segment overall rating), `WhoopSnapshot` (one row per day; cached recovery/HRV/RHR/strain/sleep pull served by `/whoop/today`), `LeetcodeSnapshot` (one row per UTC date; cached pull from leetcode.com/graphql — streak/today_count/week_count + raw 365d submission calendar; served by `/leetcode/today`, lazy-fetched via `leetcode_service.get_or_fetch`), `GooniTake` (daily LLM-generated takes — kind="focus" one-sentence on what Daniel's focused on, kind="dev" short paragraph on what Daniel shipped today; UNIQUE on (`day`, `kind`); upserted by `take_service.get_or_generate`), `NoteComment` (Confluence-style flat comment thread under each note; CASCADE-deletes with the note; `author` is a free-text label like "daniel"/"gooni"/"claude")
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Local SQL-backed memory store (the `memories` table). Per chat exchange: `extract_candidates` (LLM) → cosine-search similar active memories → `reconcile_candidate` (LLM, ADD/UPDATE/DELETE/NONE) → apply. Retrieval injects always-included preferences plus top-5 facts/episodes by cosine similarity. Replaced the old Mem0 hosted service; legacy callers still see `{id, memory, ...}` dict shape via `_serialize`.
- **`app/services/orchestrator.py`** — Unified chat handler across all surfaces (web, telegram, whatsapp, imessage). `Orchestrator` singleton. Source defaults to `"web"`; bot channels share a single persistent conversation per source (no gap-based sessioning). Each turn builds a structured trace via `TraceBuilder` and stamps it on `Message.trace`.
- **`app/tools/`** — chat tool surface exposed to the LLM via OpenAI function-calling. Registry in `app/tools/__init__.py` (~22 tools): memory (save_memory), web (web_search, fetch_url), lists (add_to_list, show_list, check_list_item), notes (search_notes, add_note, find_note, read_note, list_recent_notes), todos (add_todo, list_todos, set_todo_state — 3-state: not_yet|doing|done), focuses (add_focus, list_focuses), feature_request, calendar (5). Destructive tools (delete/forget/edit-memory/backlog ops) are deliberately NOT exposed to chat — chat surface is non-destructive by design so SMS typos can't wipe data. Dev-only / Claude-Code-only tools live in `mcp/server.py` and stay there.
- **`app/services/trace_builder.py`** — `TraceBuilder` helper + `PROMPT_VERSION` constant. Single source of truth for the per-turn trace shape: `{key, label, input, output, meta}` per step plus a leading `pipeline_version` step. Bump `PROMPT_VERSION` when you change orchestrator flow / master prompt assembly / memory pipeline so eval ratings can be filtered by pipeline iteration. Backward-compat aliases (`type`, `detail`, `args`) keep the existing chat MessageBubble rendering until it migrates.
- **`app/services/eval_service.py`** — Eval loop for chat replies. Segments conversations (web = 1 conv = 1 segment; bot threads sliced by `EVAL_GAP_HOURS`, default 4). CRUD for `EvalSegment`, `EvalStepFeedback`, and `EvalMessageRating` (per-message thumbs). Dispatches finished evals to a Claude Code space note + a backlog list item (idempotent on re-dispatch — overwrites the prior note rather than spawning duplicates). Dispatch body uses TipTap-compatible HTML (no `<details>`/`<summary>` — those are silently dropped by StarterKit and were the cause of dispatched notes rendering empty) and stamps `excerpt` on the note alongside `content` so list-view previews populate immediately. Static `TOOL_LEGEND` seeds the ⓘ legend popup in the eval UI.
- **`app/services/feedback_detector.py`** — Natural-language feedback detector (regex pre-filter + gpt-4o-mini classifier). Used by the orchestrator + eval surfaces to identify follow-up messages that critique a prior assistant reply.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound` pipeline. Per-channel impls: `telegram.py`, `whatsapp.py`, `imessage.py`. Each owns its outbound formatter (markdown → channel-native), allowlist, and send client. Webhook routes in `app/main.py` call `dispatch_inbound(channel, sender, text, db)` → orchestrator → channel-specific reply. `dispatch_inbound` returns `(raw_text, [formatted_segments])`: bot replies are split into 1–4 short bubbles via `split_for_bots` (paragraph-aware, sentence-aware for long paras, ≤4 bubbles, ≤320 chars each) so WA/Telegram/iMessage feel like texting instead of one wall of text. Web chat doesn't use `dispatch_inbound` and stays unsplit. Callers iterate segments with a short delay between sends; Telegram also fires `chat.send_action(typing)` between bubbles.
- **`app/services/note_service.py`** — Embedding + space suggestion + related notes (OpenAI embeddings, cosine similarity).
- **`app/services/take_service.py`** — Daily LLM-generated takes. `get_or_generate(db, kind, force=False)` upserts a `GooniTake` row keyed on (today, kind). kind="focus" reads recent notes + active focuses; kind="dev" reads commits/PR titles across tracked repos (last 24h). Empty takes aren't persisted — keeps yesterday's row alive when today's source is empty (no commits, no notes). `PROMPT_VERSION` constant — bump when prompt/input shape changes so history rows from different eras can be filtered apart.
- **`app/services/image_storage.py`** — Cloudflare R2 (S3-compatible) image uploader. Used by `POST /uploads/image` for pasted/dropped images so notes carry URLs instead of multi-MB base64 data: URLs (PR #134 OOM postmortem). Returns `R2NotConfigured` when env is missing — route translates to 503 and the frontend falls back to inline base64.
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "chat" | "lists" | "eval" | "stats"`. Top-right pair of icon buttons (Globe = public profile, Plug = MCP) lives here, fixed-position, visible on every view.
- **`components/eval/EvalView.tsx`** — Eval tab. Grid of conversation segments (Google Docs-style cards) w/ per-source border + badge (web/telegram/whatsapp/imessage), filters (source, status, has-flag, search), and detail view per segment. Detail view: transcript + per-message trace cards (intent / memory_recall / master_prompt / extracted_signals / memories_applied / tool_call / reply), red-flag popover per step (1/2/3 + comment), overall summary editor, ⓘ tool-legend popup, and a "Dispatch to Claude Code" button that bundles the eval into a `Claude Code` space note plus a backlog list item.
- **`routes/public.tsx`** — Layout shell for `/public/*` (just renders `<Outlet />`).
- **`routes/public.index.tsx`** — Public portfolio list: Posts tab (space-filtered) + About tab (bio).
- **`routes/public.$noteId.tsx`** — Full public note detail page.
- **`components/notes/Sidebar.tsx`** — 200px. Two draggable sections (Notes / Chat), order persisted in localStorage. Notes section has: All Notes, collapsible Spaces list, recent notes. Chat section has: New Chat + recent conversations.
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px).
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s. `🌐 Public` toggle pill. Supports image drag/drop + paste (base64 inline). `hasChanges` ref prevents spurious saves on blur.
- **`components/ChatView.tsx`** — Full chat view when chat section is active. Uses `chat/InputBar` (Gemini-style: + popup → upload image, model selector, mic for Web-Speech-API voice-to-text, send). Image attachments flow as base64 data URL via `image_url` to `/conversations/{id}/messages`.
- **`components/Dashboard.tsx`** — Greeting + day-streak stat tile (notes-this-week was dropped in the dashboard revamp). Gooni's Take pill (focus take, kind="focus" from `gooni_takes`) above the composer; Dev Take (kind="dev") below the work surfaces. Below the composer: `WhoopStrip` (3 slim cards — Recovery / Sleep / Strain — only renders when Whoop is connected) → `FocusCardsRow` (horizontal cards w/ color rail + X/Y progress, "+ add" creates a committed focus inline) → `TodoList` (primary singleton crowned at top, open todos w/ `doing` floated above `not_yet`, inline create, age tag, cascade-done animation, Done section toggle: Completed today ↔ Dev activity). Public bio editor lives on `/public`, not the dashboard.
- **`components/dashboard/TodoList.tsx`** — Pulls `/todos` (primary + open + done_today buckets). 3-state cycle: empty square → dotted half (doing) → filled check (done); from done, click pops a state-picker. Focus color dot per row (resolves via `utils/focusColors.ts`). Hover row exposes promote-to-primary (crown) + delete (×).
- **`components/dashboard/FocusCardsRow.tsx`** — Pulls `/focuses`. Horizontal scrollable row, card per active focus w/ color left-rail + dot, X/Y progress bar of linked todos sourced from `_focus_tree_node`.
- **`components/dashboard/WhoopStrip.tsx`** — 3 slim cards (Recovery/Sleep/Strain) gated on Whoop status; uses cached `/whoop/today` payload.
- **`utils/focusColors.ts`** — Mirror of backend `_COLOR_PALETTE` (10 colors). `resolveFocusColor(color, id)` falls back to id-derived palette index when stored color is null (legacy rows).
- **`components/FocusFlow.tsx`** — Legacy focus-flow editor (committed/pending/someday + spotlight + Quick/Slow). Mounted via `ActivityCard` in the Dashboard's Done section toggle.
- **`components/StatsView.tsx`** — Sidebar entry "Stats". Sections: OpenAI usage (live month-to-date from Admin API), Claude Code usage, **Whoop today** (recovery ring + HRV/RHR/strain + sleep block; only renders when Whoop is connected), **LeetCode** (streak + today/past-7d submissions + 53×7 GitHub-style heatmap; reads from cached `/leetcode/today`, configurable via `LEETCODE_USERNAME` env, defaults to `gubith1`), Dev activity (streak + Gooni's Dev Take + per-repo recent commits — Dev Take is kind="dev" from `gooni_takes`, derived from commits/PRs across tracked repos), Activity (notes/messages/conversations/todos counters).
- **`components/SettingsModal.tsx`** — Tabbed modal: Appearance (theme + face), Notifications (daily nudge), Integrations (Google Calendar + GitHub + Whoop w/ real logos — connect/disconnect only, live data lives in StatsView), Deployments (Fly + Vercel health pings). Version always shown in the tab sidebar header.
- **`components/FocusOverlay.tsx`** — Distraction-free overlay surfaced from the primary focus row's "focus" pill. Blurs the page, shows meditating Gooni, fades chrome on idle, exits via X / Esc.
- **`components/QuickNav.tsx`** — Cmd+K command palette mounted in `__root.tsx`. Jumps to home / lists / memories / audit / stats / public / mcp from any view.
- **`components/QuickComposer.tsx`** — Cmd+E quick-capture composer mounted in `__root.tsx`. Body-only TipTap modal (StarterKit + Image), saves to General via `apiCreateNote`, dispatches `gooni:note-created` window event so any mounted Dashboard re-pulls stats. Submit on Cmd+↵, newline on ⇧↵, esc / click-outside to close.
- **`components/GooniPanel.tsx`** — Chat panel (300px). Passes active note as context. Composer has a chat ↔ note mode toggle in the header (state in `useGooniStore.composerMode`, persisted): note mode hides starter prompts, swaps mascot/header dot/composer accents to yellow, expands the textarea, and saves the body to General via `apiCreateNote` (Cmd+↵) — same fire-and-forget shape as QuickComposer, no LLM round-trip.
- **`stores/useNotesContentStore.ts`** — Selected space, notes per space, active note, isDirty. Persist key: `gooni-notes-v1`.
- **`stores/useSpacesStore.ts`** — Space list from backend (includes General).
- **`stores/useConversationsStore.ts`** — Conversations list + active conversation. `send()` accepts `imageUrl` for chat-input image attachments.
- **`stores/useGooniStore.ts`** — GooniPanel open state, surface (modal/sidebar), and composer mode (chat/note). Persist key: `gooni-v4` (bumped when `composerMode` was added).
- **`stores/useGooniThemeStore.ts`** — Themes: `cool|warm|mint|rose|slate|dark`. `routes/__root.tsx` syncs the selected palette to CSS custom properties (`--gooni-bg`, `--gooni-text`, etc.) so migrated components render theme-aware via `var()` w/ light fallbacks. Non-migrated surfaces stay light under dark mode until incrementally migrated.
- **`services/api.ts`** — All fetch calls. Key interfaces: `ApiNote`, `ApiSpace`, `PublicNote`, `PublicNoteDetail`.

### MCP Server (`mcp/server.py`)
Exposes Gooni to Claude Code via stdio. Tools:
- `get_context(query)` — semantic memory search
- `add_memory(content)` — store a memory
- `search_memories(query, limit)` — search memories
- `edit_memory(id, content)` — update a memory
- `forget_memory(id)` — delete a memory
- `add_note(title, content, space_name?, is_draft?, is_pinned?)` — create a note (defaults to "Claude Code" space). `is_draft=True` surfaces it in the Drafts sidebar; `is_pinned=True` pins it.
- `search_notes(query, limit)` — semantic note search
- `edit_note(note_id, title?, content?, is_draft?, is_pinned?)` — update an existing note. `is_draft` / `is_pinned` are tri-state (None=unchanged, True/False sets the flag).
- `find_note(match, limit)` — substring scan over recent notes; returns id + title preview
- `delete_note(note_id)` — irreversible; pre-fetches title for audit
- `add_comment(note_id, content, author?)` — append a Confluence-style comment to a note's thread. `author` defaults to "claude" — pass "gooni" when calling from the orchestrator instead.
- `list_comments(note_id)` — read all comments on a note, oldest first.
- `get_leetcode_activity()` — pull Daniel's cached LeetCode snapshot (streak / today count / past-7d count / total solved / global rank). Reads `/leetcode/today`; reflects whatever lazy daily pull last ran.
- `list_spaces()` — list all spaces
- `list_notes(space_id, limit)` — browse notes in a space
- `read_list(list_ref="todo", limit, include_done)` — read items from a list (todo / focus singletons + user-defined lists). Resolves by type → name → numeric id. **`list_ref="backlog"` is REJECTED** — backlog tickets live in their own table; use `read_backlog` instead.
- `add_list_item(text, list_ref="todo", subtitle?, skip_conflict_check=False)` — add to a list_items list. Cosine-checks against existing items; near-duplicates surface as `conflicts: [{id, text, similarity, severity}]`. **`list_ref="backlog"` is REJECTED** — use `add_backlog_item`.
- `find_similar_items(text, list_ref="todo", threshold=0.78, limit=5)` — read-only similarity search over a list_items list. **`list_ref="backlog"` is REJECTED** — use `find_similar_backlog`.
- `check_list_item(match, list_ref="todo", done=True)` — toggle done by text match (first-hit-wins). **`list_ref="backlog"` is REJECTED** — use `complete_backlog_item`.
- `delete_list_item(match, list_ref="todo")` — delete by text match; refuses ambiguous matches. **`list_ref="backlog"` is REJECTED** — use `delete_backlog_item`.

**Backlog tickets** (own `backlog_tickets` table — separate from list_items since the focus/todo/backlog extraction):
- `read_backlog(limit, include_done)` — list tickets w/ board_status + pr_url
- `add_backlog_item(text, subtitle?, skip_conflict_check=False)` — create; conflict scan via the new `POST /backlog/tickets/similar` route. Same `conflicts` response shape as `add_list_item`.
- `find_similar_backlog(text, threshold=0.78, limit=5)` — read-only cosine search across the board.
- `complete_backlog_item(match)` — mark a ticket done by text match.
- `delete_backlog_item(match)` — delete a ticket; refuses ambiguous matches.

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

## Schema changes (Alembic)

```bash
# After editing app/db/models.py:
source venv/bin/activate
alembic revision --autogenerate -m "what you changed"
# Review the generated file in alembic/versions/. SQLite quirks to
# watch: Boolean stored as INTEGER (cosmetic), DateTime stored as
# TEXT (cosmetic), missing FK constraints (SQLite doesn't enforce).
# compare_type=True is on, so type drifts surface.
alembic upgrade head                     # apply locally
# Commit the new revision file alongside your model change.
```

`alembic upgrade head` runs automatically on uvicorn boot via
`_alembic_upgrade()` in `app/main.py`, so prod picks up new migrations
on next deploy. The legacy cutover branch (`_run_column_migrations` /
`_migrate_memories_legacy_schema` / `_backfill_memories` + the
`create_all` before stamping) was deleted — every active environment is
past baseline, and the pre-stamp `create_all` was the root cause of the
"table already exists" crash loop on new add-table migrations.

## Key API Endpoints

```
GET  /spaces                    → list spaces
POST /spaces                    → create space { name, emoji? }
PATCH /spaces/{id}              → update space { name?, emoji? }
DELETE /spaces/{id}             → delete space + its notes
GET  /spaces/{id}/notes         → notes for space (use "general" for all). Returns list-shape rows: `content` is null, `excerpt` (≤240 char preview) + `thumb_src` (external image URL only) populated server-side. Same shape served by /notes/recent, /notes/pinned, /notes/drafts, /notes/{id}/related, /notes/{id}/children, dashboard.recent_notes — full body lives behind GET /notes/{id} only.
POST /spaces/{id}/notes         → create note
PATCH /notes/{id}               → update note { title?, content?, space_id?, is_public? }
DELETE /notes/{id}              → delete note
POST /notes/{id}/embed          → generate embedding + suggest space
POST /notes/{id}/touch          → update last_opened_at
POST /notes/{id}/memorize       → extract facts → memory store

GET  /notes/{id}/comments       → list comments on a note (oldest first)
POST /notes/{id}/comments       → append comment { content, author? }
DELETE /comments/{id}           → delete a comment by id

POST /uploads/image             → multipart image upload → Cloudflare R2; returns { url, key }. Used by NoteEditor paste/drop. Returns 503 when R2 env unset → frontend falls back to inline base64 (legacy path). 10 MB per upload, image/* content-types only.

GET  /public/notes              → public notes list { id, title, space_name, excerpt, updated_at }
GET  /public/notes/{id}         → full public note (404 if not public)
GET  /public/profile            → { bio, avatar_url, note_count, last_active }
PATCH /public/profile           → partial save { bio?, avatar_url? }. `avatar_url: null` clears back to the goofy-emoji default. Avatar uploads go through POST /uploads/image first to get the R2 URL.

POST /chat                      → Gooni chat { content, entry_content?, model? }
GET  /feed                      → all conversations
GET  /conversations/{id}/messages
POST /conversations/{id}/messages → send message + get reply

GET  /dashboard                 → stats + focuses
GET  /dashboard/take            → today's focus take (one-sentence; persisted in `gooni_takes` kind="focus", upserted on (day, kind)); ?force=1 regenerates
GET  /dashboard/dev-take        → today's dev take (short paragraph; persisted in `gooni_takes` kind="dev"); ?force=1 regenerates
GET  /dashboard/takes/history?kind=focus|dev&limit=N → reverse-chronological history of stored takes (for future "how my focus drifted" surfaces)
GET  /dashboard/stats           → extended counters (notes/messages/conversations/todos this-week + total)
GET  /dashboard/openai-usage    → live month-to-date OpenAI usage from Admin API (configured? spend, requests, tokens, by-model breakdown). Requires OPENAI_ADMIN_KEY (sk-admin-…).
GET  /dashboard/claude-usage    → Claude Code usage. Source = local jsonls if `~/.claude/projects` exists (dev laptop), else `claude_usage_turns` DB rows (prod). Returns `available: bool` — frontend hides the section entirely when false (fresh prod box, no upload yet).
POST /dashboard/claude-usage/ingest → append-only ingest of {turns: [{session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}]}. Idempotent via UNIQUE(session_id, ts). Called by `scripts/upload_claude_usage.py` from the laptop.
POST /focuses                   → create focus { name, commitment, due_date? }

GET  /debug/memories            → inspect stored memories
GET  /leetcode/today            → cached LeetCode snapshot {available, streak, today_count, week_count, total_solved/easy/med/hard, ranking, calendar (last 365d), updated_at}; lazy daily fetch via `leetcode_service.get_or_fetch`. ?refresh=1 forces a live re-pull from leetcode.com/graphql. Username = LEETCODE_USERNAME env, defaults to `gubith1`.
POST /webhooks/whatsapp         → Meta Cloud API webhook (HMAC-verified)
GET  /webhooks/whatsapp         → Meta verify-token handshake
POST /webhooks/imessage         → BlueBubbles bridge webhook (X-Secret header)

GET  /settings                       → daily digest config (hour/min/tz/channels/enabled + nudge_prompt)
PATCH /settings                      → update any subset of nudge_* fields, including nudge_prompt
GET  /settings/nudge-prompt-default  → bundled default LLM instruction (used by the "Use default" button)
POST /settings/test-nudge            → fire the digest immediately (bypasses idempotency)

GET  /items?limit=50&offset=0   → focus + inbox tree (status, scale per node). Root-level pagination — server caps at 50 top-level items per tree by default; clamped to [1,200]. Each surviving root keeps its full subtree. Response carries `total_focuses` / `total_inbox` for "load more" UI.
POST /items                     → create item; accepts status, scale, color in body. is_primary on items is a no-op now (moved to Todo).
PATCH /items/{id}               → patches accept status + scale + color. status syncs `committed`.

# Dashboard revamp routes (own dedicated tables, slim shapes):
GET  /focuses                   → active (not-done) focuses, each w/ color + linked-todo progress {done,total} from `_focus_tree_node`. Drives the dashboard FocusCardsRow.
GET  /todos                     → bucketed payload {primary, open, done_today}. `open` is sorted with `doing` floated above `not_yet`.
POST /todos                     → inline-create. Body: `{text, focus_id?, due_date?, subtitle?, state?}`.
PATCH /todos/{id}               → patch any of `{text, subtitle, state, focus_id, is_primary, due_date, sort_order, done}`. Setting `state="done"` (or `done=true`) auto-clears `is_primary` and syncs the linked backlog ticket (if any).
POST /todos/{id}/cycle          → two-click checkbox handler: not_yet → doing → done. From `done`, the FE pops a state-picker — programmatic cycle bounces back to not_yet.
POST /todos/{id}/promote-to-primary → singleton: clears any other primary, sets this one. Idempotent.
DELETE /todos/{id}              → also clears `backlog_tickets.todo_id` for any linked ticket.

POST /backlog/tickets/{id}/promote → idempotent. Creates a Todo mirroring text/subtitle and stores `ticket.todo_id`. Re-promote returns the existing pair.
POST /backlog/tickets/{id}/demote  → deletes the linked Todo, clears `ticket.todo_id`. Backlog row stays.

POST /lists/{id}/items          → add item; response includes `conflicts: [{id, text, similarity, severity}]` for near-duplicates already in the list. Pass `skip_conflict_check: true` to bypass the embed scan.
POST /lists/{id}/similar        → cosine-search a list { text, threshold?, limit?, include_done?, exclude_item_id? } → { matches: [{id, text, similarity}] }. Read-only.
```

### Focus / Todo / Backlog tables (extracted from list_items)

After the focus/todo/backlog extraction, `list_items` is back to its
original purpose: arbitrary user-defined lists. Three dedicated tables
own the previously-overloaded fields:

- **`focuses`** (`Focus` model, `app/services/focus_service.py`):
  long-running commitments. Carries `endgoal`, `committed`, `status`
  ('committed' | 'someday'), `scale` ('quick' | 'slow'), `health`
  (0..100), `confidence` (0..100), `start_at`, `end_at`, and `color`
  (auto-assigned from a 10-color palette via `_next_color`, cycled by
  total focus count). **Post-revamp:** `is_primary` MOVED to Todo
  (active-execution lives there); the `focus_todo_links` M2M table is
  GONE — todos link via `todos.focus_id` single-FK. Routes via `/items/*`
  (item_service facade) AND the new `/focuses` GET.
- **`todos`** (`Todo` model, `app/services/todo_service.py`): actionable
  items with optional `due_date`. Carries `state` enum
  ('not_yet' | 'doing' | 'done', synced w/ legacy `done` bool),
  `focus_id` single-FK to its parent focus, and `is_primary` singleton
  (only one Todo across the whole table can be True; auto-cleared when
  the row flips to done). Routes via `/items/*` AND the new `/todos*`
  family (GET buckets / POST create / PATCH / cycle /
  promote-to-primary / DELETE).
- **`backlog_tickets`** (`BacklogTicket` model,
  `app/services/backlog_service.py`): engineering backlog tickets with
  `board_status` ('not_yet' | 'doing' | 'done' — vocab remapped from
  legacy 'todo'/'in_progress' by the dashboard-revamp migration),
  `pr_url`, and `todo_id` FK (set when promoted into a Todo via
  `/backlog/tickets/{id}/promote`; cleared by `/demote`). Auto-routed
  from notes via `feature_request_tool` when the classifier flags a
  feature_request signal.

`item_service` is now a thin facade over focus_service + todo_service —
existing `/items/*` routes still work unchanged. `_serialize_item` is
polymorphic (Focus → serialize_focus, Todo → serialize_todo).

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

### Focus ↔ Todo link (single FK)

Post-dashboard-revamp the M2M `focus_todo_links` table is gone — a Todo
links to at most one Focus via `todos.focus_id`. Endpoints kept for
back-compat with the legacy item_service callers; `/items/{todo_id}/focuses`
returns a 0-or-1-element list now.

- `POST /items/{focus_id}/derive-todo` — create a leaf todo with
  `focus_id` set in one shot. Body `{text, due_date?}`. Returns
  `{todo, link_id}` (link_id mirrors `todo.id` since there's no separate
  link row).
- `GET  /items/{focus_id}/todos` — todos with `focus_id == focus_id`.
- `GET  /items/{todo_id}/focuses` — 0-or-1-element list (the parent focus).
- `GET  /items/today-todos` — open todos due today; each row carries a
  `focuses: [chip]` array (always 0 or 1 element under the new FK model).
- To sever a focus↔todo link: `PATCH /todos/{id}` with `focus_id: null`.

## Code Patterns

- **Zustand persist**: if you change a store's shape, bump the persist key to avoid stale state (e.g. `v1` → `v2`)
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom — whole app shares it
- **FastAPI `db: Session = Depends(get_db)`** — session created/closed per request automatically
- **Schema changes via Alembic**: every schema mutation goes through `alembic revision --autogenerate -m "msg"` then `alembic upgrade head`. Migrations live in `alembic/versions/`. `app/main.py:_alembic_upgrade` runs `upgrade head` on every boot. No `Base.metadata.create_all` at runtime — alembic alone owns schema. Fresh DBs walk from baseline (`ebbf04b84ba5`) to head on first boot.
- **Optimistic UI**: `createNote` adds a temp note instantly, replaces with real API response
- **React StrictMode**: kept intentionally — double-fires effects in dev to expose bugs; never remove it
- **hasChanges ref**: NoteEditor only calls save() if user actually typed — prevents updated_at being touched on blur
- **Public routes**: `/public` and `/public/$noteId` are standalone pages (no sidebar, no auth)
- **Images in notes**: base64 data URLs stored inline in note content via TipTap Image extension
- **Deferred embedding columns**: `Note.embedding`, `Note.classified_embedding`, `ListItem.embedding`, `Memory.embedding` are wrapped in `deferred()`. ORM hydration skips them — list/read endpoints don't pay the ~31KB-per-row cost. Similarity callers must opt back in via tuple queries (`db.query(Note.id, Note.embedding).all()`) instead of `.query(Note).all()` to avoid an N+1 lazy-load storm. Pattern lives in `note_service.search_by_query`, `list_service.find_similar`, `memory_service` retrieval.

## Known Issues
