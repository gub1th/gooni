# CLAUDE.md

> Project-specific rules + index. Behavioral defaults (about Daniel, lock-goal, verify-before-push, keep-docs-honest) live in global `~/.claude/CLAUDE.md` — not duplicated here.

## Goal

Gooni = personal AI notebook → ambient home assistant. Loop:
1. Write notes (Apple Notes layout: spaces → list → editor)
2. Gooni (gpt-4o-mini) reads active note, answers / gives feedback
3. Memory built from notes in SQLite `memories` table (extract → reconcile via LLM, cosine-retrieved at chat time)

Mobile capture via bots: Telegram (live), WhatsApp (live), iMessage (code shipped, awaiting Mac+BlueBubbles). All route through `MessagingChannel` ABC in `app/services/messaging/`.

## North Star

Ambient physical assistant — device that knows you passively, surfaces context proactively. Gooni = brain. See `docs/VISION.md`.

## Project Rules

- Don't add new features without being asked
- Don't change DB schema without flagging
- Don't install new deps without asking
- **Call `mcp__gooni__add_memory` after meaningful work or product discussion** — code changes, architectural decisions, feature ideas. Gooni should know what was built AND what Daniel is thinking about.
- **One-line takeaway per merged PR.** After merge, ask Daniel "what did you learn shipping this?" → write to a Gooni note via `mcp__gooni__add_note` (or `add_memory` if more durable than note-shaped). Title `"PR #N takeaway: <topic>"`, body = his sentence + one-line context. Skip for pure plumbing (typo/version bump) or if he says skip.
- **Check off backlog items as you ship.** Commit pushed = call `mcp__gooni__check_list_item` with a unique substring. Don't batch at session end. If one PR closes multiple, check off each.
- **Backlog ticket lifecycle (Jira flow).** Every non-trivial task lives on the board.
  1. Before coding: `mcp__gooni__find_similar_items` (threshold 0.78). If exists, `PATCH /backlog/tickets/{id} {"board_status":"doing"}`. Else create then flip.
  2. Working: stays `doing`. Scope shifts → edit the same ticket.
  3. On PR merge: `PATCH /backlog/tickets/{id} {"board_status":"done","pr_url":"..."}`.
  4. One ticket per PR; bundled PRs do N sequential PATCHes w/ same pr_url.
  Vocab: legacy `'todo'`/`'in_progress'` was remapped to `'not_yet'`/`'doing'`. Skip only for trivial fixes.

## Current Priorities

See `docs/TODO.md` (gitignored — local only).

## Architecture

### Backend (`app/`)

- **`app/main.py`** — FastAPI routes + startup migrations. CORS allows `localhost:5173`. Daily nudge scheduler + capability telemetry rollup live in lifespan.
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`.
- **`app/db/models.py`** — SQLAlchemy models. Grep for fields; high-leverage notes only:
  - `Note` — `excerpt` cached preview (≤240 char, HTML/img stripped) populated on save; lazy-backfilled at startup. List endpoints don't ship full body.
  - `Focus` — long-running commitment. Color auto-assigned from 10-color palette. Drift cols: deferred `initial_signature` (frozen at promotion) + `current_signature` (EMA-updated per bind), `missed_run_count` (≥3 → `status='dormant'`), `drift_flagged_at` (one-shot when `1-cos(initial,current) > 0.35`), `evolved_from_focus_id` (lineage via `/focuses/{id}/fork`).
  - `Todo` — 3-state `state` enum (`not_yet|doing|done`), single-FK `focus_id`, singleton `is_primary` (auto-cleared on done).
  - `BacklogTicket` — `board_status` (`not_yet|doing|done`), `pr_url`, `notes` (multi-line body), `todo_id` (FK set on `/promote`).
  - `Memory`, `Message`, `Conversation` — embedding cols are `deferred()` (see Code Patterns).
  - `FocusCandidate` — synth-surfaced, lifecycle `proposed → promoted|dismissed`. Upsert key = `cluster_signature` (sha256). Status sticky on re-emit; seen_count bumps.
  - `Reflection` — per-turn self-eval (Reflexion pattern). Sev ≥ 2 + gap → cosine-cluster, 3+ matches at 0.8 auto-promotes a behavioral `CapabilityFacet`.
  - `CapabilityFacet` — Gooni's self-knowledge. UNIQUE `facet_key`. Layers: `mechanical` (boot-scan) / `functional` (manual) / `behavioral` (reflection-promoted) / `architectural` (manual). Status flipped by ToolCall telemetry.
  - `ToolCall` — audit row per chat-tool call. `running → done|failed`. Substrate for anti-hallucination layer.
  - `WaProcessedId` — wamid idempotency for WhatsApp retries.
  - Singletons: `Space`, `List`, `ListItem`, `PublicProfile`, `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall`, `ClaudeUsageTurn`, `EvalSegment`, `EvalStepFeedback`, `EvalMessageRating`, `WhoopSnapshot`, `LeetcodeSnapshot`, `GooniTake`, `NoteComment`, `Habit`, `HabitEntry`.

- **`app/services/memory_service.py`** — Local SQL memory store. Per exchange: extract → cosine search → reconcile (ADD/UPDATE/DELETE/NONE) → apply. Retrieval = always-included prefs + top-5 cosine. `build_memory_context_with_debug` prepends `capability_service.build_prompt_block` ("Who I am right now") before prefs.
- **`app/services/reflexion_service.py`** — Per-turn Reflexion (Shinn et al.). Daemon thread w/ own SessionLocal after each assistant Message. Cost ~$0.0001/turn. Hook in `orchestrator.py` after normal-reply AND short-circuit feedback_ack (highest-leverage spot: "logged but didn't act" failure mode).
- **`app/services/capability_service.py`** — Owns `capability_facets`. `refresh_mechanical_layer` runs at lifespan start (walks tool registry + routes + messaging channels). `run_telemetry_rollup` daily 03:00 — counts ToolCall rows, flips verified/unverified/broken. `build_prompt_block` formats functional/behavioral/architectural layers (mechanical implicit in function schemas), capped at 30 lines.
- **`app/services/orchestrator.py`** — Unified chat across web/telegram/whatsapp/imessage. `Orchestrator` singleton. Bot channels = single persistent conv per source. Each turn builds `TraceBuilder` trace stamped on `Message.trace`.
- **`app/tools/`** — LLM function-calling surface (~23 tools): memory, web, lists, notes, todos (3-state), focuses, habits (fuzzy name resolve, refuses unknown), feature_request, calendar (5). Destructive tools (delete/forget/edit-memory/backlog ops) deliberately NOT exposed to chat — SMS typos shouldn't wipe data. Dev-only tools stay in `mcp/server.py`.
- **`app/services/trace_builder.py`** — `TraceBuilder` + `PROMPT_VERSION`. Bump version when orchestrator flow / master prompt / memory pipeline change so eval ratings filter cleanly.
- **`app/services/eval_service.py`** — Eval loop. Segments conversations (web = 1 conv = 1 segment; bots sliced by `EVAL_GAP_HOURS`, default 4). `get_segment_full` joins ToolCall audit per message (trace = intended, audit = actual). Dispatches to Claude Code space note + backlog item (idempotent re-dispatch). TipTap-compatible HTML only (no `<details>` — silently dropped by StarterKit).
- **`app/services/feedback_detector.py`** — Regex pre-filter + gpt-4o-mini classifier. Detects follow-ups critiquing prior reply.
- **`app/services/focus_synthesizer.py`** — Probe-quality focus surfacer. Gather → embed (cached on `Message.embedding`) → greedy cosine cluster → pairwise merge → sub-cluster → classify (`focus|state|noise`) → state→focus binding (absolute floor 0.38 + 0.10 margin). Pure probe, no DB writes. `POST /focus-synthesis/run`.
- **`app/services/focus_candidate_service.py`** — `FocusCandidate` lifecycle. `persist_run` upserts by `cluster_signature`. `promote()` creates Focus, stamps initial+current signature = candidate centroid. State/noise clusters NOT persisted.
- **`app/services/focus_service.py`** — Focus CRUD + hybrid binding (`bind_to_clusters`). Each synth run: cosine ≥ 0.70 match (1-to-1, desc sim) → EMA-blend (α=0.7 old, 0.3 new) → refresh evidence + last_seen. Unbound active focuses bump `missed_run_count`; ≥3 → dormant. Drift flagged when `1-cos(initial,current) > 0.35`. `rename` snaps initial := current + clears flag. `fork` flips old to evolved + spawns new w/ lineage link.
- **`app/services/habit_service.py`** — Habit CRUD + entry upsert + streak / 7-day-strip. Streak walks back from today (one grace day for unlogged today); explicit False or missing day breaks. `find_by_name_fuzzy` = case-insensitive substring. Polarity is metadata only, never inverts value semantics.
- **`app/services/health_service.py`** — 6-axis composite scoring (memory/chat/engagement/availability/cost/connectors). Each axis: 0-100 composite + per-component breakdown. Try/except per axis — one failure can't take down dashboard. `PROCESS_START_MONOTONIC` stamped at import for uptime.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound`. Per-channel impls own outbound formatter, allowlist, send client. Returns `(raw, [segments])` — replies split into 1-4 short bubbles (≤320 char each) via `split_for_bots`. Web doesn't use this (stays unsplit).
- **`app/services/note_service.py`** — Embedding + space suggest + related notes (OpenAI embeddings, cosine).
- **`app/services/take_service.py`** — Daily LLM takes (`GooniTake`, kind=focus|dev). `PROMPT_VERSIONS` per kind; stale rows auto-regenerate. Empty takes not persisted (keeps yesterday alive when source is empty). **Dev take = JSON** (v3): array of `{theme, summary}`, max 5. Frontend `parseDevTake` handles legacy v2 prose.
- **`app/services/image_storage.py`** — Cloudflare R2 uploader. `POST /uploads/image`. `R2NotConfigured` → 503 → frontend falls back to inline base64.
- **`app/llm/client.py`** — OpenAI wrapper. Default `gpt-4o-mini`. `_execute_with_audit` writes ToolCall rows; failures logged + swallowed (never breaks chat path).

### Frontend (`frontend/src/`)

Index of files. Internals grep-able.

- **`routes/index.tsx`** — Top-level layout. View state: `"notes"|"dashboard"|"chat"|"lists"|"eval"|"stats"`. Fixed top-right icon pair (Globe = public, Plug = MCP).
- **`routes/public.tsx`, `public.index.tsx`, `public.$noteId.tsx`** — Standalone public portfolio (no sidebar, no auth).
- **`components/eval/EvalView.tsx`** — Eval tab. Per-source border + badge, filters, segment detail w/ trace cards + ToolCall audit + red-flag popover + dispatch-to-Claude-Code.
- **`components/notes/Sidebar.tsx`, `NotesList.tsx`, `NoteEditor.tsx`** — Sidebar 200px (draggable Notes/Chat sections), list 260px, editor (TipTap, auto-save 1.5s, image drag/paste).
- **`components/ChatView.tsx`** — Full chat. Text-only streams via SSE (`/messages/stream`); image turns + bots stay blocking.
- **`components/Dashboard.tsx`** — Single-column. Mode toggle (Today|Ops|Pulse, key `gooni-dashboard-v3`, migrate maps legacy `build` → `ops`). Today body reacts to `composerFocused` (collapses TakeTabs, dims focuses/todos block).
- **`components/dashboard/`** — TodoList (3-state cycle), FocusCardsRow (3-col + halo), DashboardHeader, TabToggle, FocusesView (SynthesizerSection + FocusCard grid), FocusCard (normal/drifting/dormant states + lineage), SynthesizerSection (candidate pills, ✓/✗, ↻), FocusDrillDown (modal), HabitsStrip (7-cell tracker + streak), ModeToggle, BuildMode (health cards, folded into OpsMode), OpsMode (BuildMode + CapabilityProfileCard + EvalSection + BacklogSection + FailuresSection), PulseMode (life-stats grid), HealthCard, HealthDrillDown.
- **`components/StatsView.tsx`** — Sidebar entry. Sections: OpenAI usage, Claude usage, Whoop today, LeetCode (53×7 heatmap), Dev activity (Dev Take), Activity counters.
- **`components/SettingsModal.tsx`** — Tabbed: Appearance (theme+face), Notifications (daily nudge), Integrations (Calendar/GitHub/Whoop), Deployments (Fly+Vercel health).
- **`components/FocusOverlay.tsx`, `QuickNav.tsx` (Cmd+K), `QuickComposer.tsx` (Cmd+E), `GooniPanel.tsx`** — overlays + capture surfaces. QuickComposer dispatches `gooni:note-created` event so Dashboard re-pulls.
- **`utils/focusColors.ts`** — Mirrors backend `_COLOR_PALETTE`. `resolveFocusColor(color, id)` falls back to id-derived index for null legacy rows.
- **`stores/`** — Zustand stores. Keys: `gooni-notes-v1`, `gooni-v4` (Gooni panel + composer mode), theme store syncs CSS custom props via `routes/__root.tsx`.
- **`services/api.ts`** — All fetch calls. Interfaces: `ApiNote`, `ApiSpace`, `PublicNote`, `PublicNoteDetail`.

### MCP Server (`mcp/server.py`)

Exposes Gooni to Claude Code via stdio.

**Memory**: `get_context`, `add_memory`, `search_memories`, `edit_memory`, `forget_memory`
**Notes**: `add_note` (defaults "Claude Code" space, `is_draft`/`is_pinned` flags), `search_notes`, `edit_note` (tri-state `is_draft`/`is_pinned`: None=unchanged), `find_note`, `read_note`, `delete_note`, `list_notes`
**Comments**: `add_comment` (author defaults "claude"; pass "gooni" from orchestrator), `list_comments`
**Capability**: `read_capability_facets(layer?)`, `update_capability_facet(facet_key, facet_text?, status?, layer?)` — companion to chat-surface tool of same name in `app/tools/update_capability_tool.py`
**Stats**: `get_leetcode_activity` (reads `/leetcode/today`)
**Spaces**: `list_spaces`
**Lists** (todo + user-defined; `list_ref="backlog"` REJECTED on all — use backlog APIs): `read_list`, `add_list_item` (cosine-checks dupes), `find_similar_items`, `check_list_item`, `delete_list_item`
**Backlog tickets** (own table): `read_backlog`, `add_backlog_item` (conflict scan via `POST /backlog/tickets/similar`), `find_similar_backlog`, `complete_backlog_item` (pr_url closes lifecycle), `delete_backlog_item`

## Running

```bash
./dev.sh   # kills stale ports, opens backend + frontend tabs

# Or individually:
source venv/bin/activate && uvicorn app.main:app --reload   # :8000
cd frontend && npm run dev                                   # :5173
python scripts/telegram_bot.py
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
# Review the generated file. SQLite quirks: Boolean→INTEGER (cosmetic),
# DateTime→TEXT (cosmetic), missing FK constraints (SQLite doesn't enforce).
# compare_type=True is on, so type drifts surface.
alembic upgrade head
# Commit the new revision alongside the model change.
```

`alembic upgrade head` runs on uvicorn boot via `_alembic_upgrade()` in `app/main.py`. Legacy cutover branch deleted — all active envs past baseline. No `Base.metadata.create_all` at runtime; alembic alone owns schema. Fresh DBs walk from baseline (`ebbf04b84ba5`) to head on first boot.

## Key API Endpoints

```
# Spaces / notes
GET    /spaces                        → list
POST   /spaces                        → { name, emoji? }
PATCH  /spaces/{id}                   → { name?, emoji? }
DELETE /spaces/{id}                   → + cascades notes
GET    /spaces/{id}/notes             → list-shape (content=null, excerpt+thumb_src). Same shape: /notes/recent, /pinned, /drafts, /{id}/related, /{id}/children, dashboard.recent_notes. Full body only via GET /notes/{id}.
POST   /spaces/{id}/notes             → create
PATCH  /notes/{id}                    → { title?, content?, space_id?, is_public?, is_pinned?, is_public_pinned?, is_draft? }
DELETE /notes/{id}
POST   /notes/{id}/embed              → embed + suggest space
POST   /notes/{id}/touch              → update last_opened_at
POST   /notes/{id}/memorize           → extract → memory

# Comments
GET    /notes/{id}/comments
POST   /notes/{id}/comments           → { content, author? }
DELETE /comments/{id}

# Uploads
POST   /uploads/image                 → multipart → R2 → { url, key }. 503 when R2 env unset → FE falls back to inline base64. 10 MB, image/* only.

# Public
GET    /public/notes                  → public-pinned first, then newest
GET    /public/notes/{id}             → 404 if not public
GET    /public/profile                → { bio, avatar_url, note_count, last_active }
PATCH  /public/profile                → { bio?, avatar_url? } (null clears to goofy-emoji default)

# Chat
POST   /chat                          → { content, entry_content?, model? }
GET    /feed
GET    /conversations/{id}/messages
POST   /conversations/{id}/messages   → blocking
POST   /conversations/{id}/messages/stream → SSE: stage, tool_start, tool_done, done, error. Bots + image path stay blocking. 15s heartbeat (Fly edge proxy).

# Dashboard
GET    /dashboard                     → stats + focuses
GET    /dashboard/take                → today's focus take (kind=focus). ?force=1
GET    /dashboard/dev-take            → dev take v3 = JSON-stringified array of {theme, summary}. Legacy v2 = prose (FE parseDevTake handles both). Auto-regen on prompt_version mismatch.
GET    /dashboard/takes/history?kind=focus|dev&limit=N
GET    /dashboard/stats               → counters (notes/messages/convs/todos this-week + total)
GET    /dashboard/openai-usage        → MTD from Admin API (needs OPENAI_ADMIN_KEY)
GET    /dashboard/claude-usage        → local jsonls if `~/.claude/projects` exists else `claude_usage_turns` DB rows. `available: bool`.
POST   /dashboard/claude-usage/ingest → append-only {turns:[...]}. UNIQUE(session_id, ts). Called by scripts/upload_claude_usage.py.

# Misc
GET    /debug/memories
GET    /leetcode/today                → cached snapshot. ?refresh=1 forces live pull. Username = LEETCODE_USERNAME env, defaults gubith1.
POST   /webhooks/whatsapp             → HMAC-verified. Dedups via `wa_processed_ids` (UNIQUE wamid). Handler claims wamid → queues orchestrator via BackgroundTasks → acks fast.
GET    /webhooks/whatsapp             → Meta verify-token handshake
POST   /webhooks/imessage             → BlueBubbles bridge (X-Secret header)

# Capabilities
GET    /capabilities                  → grouped by layer. Skips `_meta`. status='removed' returned (FE dims).
POST   /capabilities                  → { facet_key, layer, facet_text, status?, source? }. 409 on dup.
PATCH  /capabilities/{id}             → { facet_text?, status?, layer? }. Auto-flips source='chat_tool_update'.
POST   /capabilities/telemetry/refresh → fire daily rollup manually
POST   /capabilities/boot-scan/refresh → fire boot scan manually (use after adding tool/route mid-session)

GET    /reflections?conversation_id&message_id&severity_min&limit=50

# Settings (daily digest)
GET    /settings                      → nudge config + nudge_prompt
PATCH  /settings
GET    /settings/nudge-prompt-default → bundled default
POST   /settings/test-nudge           → fire now (bypass idempotency)

# Items (legacy facade)
GET    /items?limit=50&offset=0       → focus + inbox tree. Root-level pagination [1,200], full subtree preserved. total_focuses + total_inbox.
POST   /items                         → status + scale + color. is_primary no-op now.
PATCH  /items/{id}                    → status syncs `committed`

# Focuses (revamp)
GET    /focuses                       → active, w/ color + linked-todo progress {done,total}. Drives FocusCardsRow.
GET    /focuses/{id}                  → detail incl. parsed evidence array. Drives FocusDrillDown.
POST   /focuses                       → { name, commitment, due_date? }
POST   /focuses/{id}/rename           → snaps initial := current, clears drift flag. { text?, endgoal? }
POST   /focuses/{id}/fork             → old → evolved, new inherits drifted current as initial+current, links via evolved_from_focus_id. { new_text, new_endgoal? }
POST   /focuses/{id}/reactivate       → dormant → committed. Clears missed_run_count + drift flag.

# Todos
GET    /todos                         → bucketed { primary, open, done_today }. open sorted doing > not_yet.
POST   /todos                         → { text, focus_id?, due_date?, subtitle?, state? }
PATCH  /todos/{id}                    → { text?, subtitle?, state?, focus_id?, is_primary?, due_date?, sort_order?, done? }. state=done auto-clears primary + syncs linked backlog ticket.
POST   /todos/{id}/cycle              → not_yet → doing → done. From done, FE pops picker (programmatic cycle bounces to not_yet).
POST   /todos/{id}/promote-to-primary → singleton. Idempotent.
DELETE /todos/{id}                    → also clears backlog_tickets.todo_id

# Backlog promote/demote
POST   /backlog/tickets/{id}/promote  → idempotent. Creates Todo mirroring text/subtitle, stores ticket.todo_id.
POST   /backlog/tickets/{id}/demote   → deletes linked Todo, clears todo_id. Ticket stays.

# Focus synthesizer / candidates
POST   /focus-synthesis/run           → pure probe (no DB writes). Body knobs: include_kinds, threshold, merge_threshold, sub_threshold, min_parent_for_subcluster, min_sub_size, min_cluster_size, classify, classify_model, state_bind_sim (0.38), state_bind_margin (0.10).
POST   /focus-candidates/run          → synth → bind clusters to existing Focuses (EMA-blend signature, refresh evidence, reset missed_run_count) → persist unbound. Returns { synth_stats, binding:{bound, dormant_focus_ids, newly_drifted_focus_ids}, persisted }.
GET    /focus-candidates?status=proposed → list. status='all' to skip filter. Ordered by confidence desc, seen_count desc.
POST   /focus-candidates/{id}/promote → creates Focus row (committed), stamps promoted_focus_id + promoted_at, flips status. Idempotent.
POST   /focus-candidates/{id}/dismiss → flips status + stamps dismissed_at. Row stays (synth respects on re-emit).

# Health
GET    /health/scores                 → 6-axis composite (memory/chat/engagement/availability/cost/connectors). Each: {axis, score, headline, components:[{name,score,weight,detail}]}. No caching. Drives Build mode.

# Habits
GET    /habits                        → active + 7-day strip + streak
POST   /habits                        → { name, polarity?, color? }
PATCH  /habits/{id}                   → { name?, color?, polarity?, sort_order?, archived? }
DELETE /habits/{id}                   → entries cascade
PUT    /habits/{id}/entries/{YYYY-MM-DD} → { value: bool, note? }
DELETE /habits/{id}/entries/{YYYY-MM-DD} → unlog (revert to unknown)

# Lists
POST   /lists/{id}/items              → adds; response includes conflicts:[{id,text,similarity,severity}]. skip_conflict_check bypasses.
POST   /lists/{id}/similar            → read-only cosine search. { text, threshold?, limit?, include_done?, exclude_item_id? } → { matches }

# Legacy focus↔todo facade (single FK under hood)
POST   /items/{focus_id}/derive-todo  → leaf todo w/ focus_id set. Body { text, due_date? }. Returns { todo, link_id } (link_id = todo.id).
GET    /items/{focus_id}/todos        → todos with focus_id == focus_id
GET    /items/{todo_id}/focuses       → 0-or-1-element list
GET    /items/today-todos             → open todos due today; each carries focuses:[chip]
```

## Tables: focuses / todos / backlog_tickets (post-extraction)

`list_items` is back to arbitrary user-defined lists. Three dedicated tables own the previously-overloaded fields:

- **`focuses`** (`Focus`, `focus_service.py`) — long-running commitments. `is_primary` MOVED to Todo. `focus_todo_links` M2M GONE — todos link via single FK.
- **`todos`** (`Todo`, `todo_service.py`) — actionable. `state` enum synced w/ legacy `done` bool. `is_primary` singleton, auto-clears on done.
- **`backlog_tickets`** (`BacklogTicket`, `backlog_service.py`) — engineering tickets. `todo_id` FK set on `/promote`, cleared by `/demote`. Auto-routed from notes via `feature_request_tool` on classifier hit.

`item_service` = thin facade over focus_service + todo_service; `/items/*` routes still work. `_serialize_item` polymorphic.

## Daily digest

`app/services/todo_nudge.py::compose_message(db)`. Daniel writes prompt in `Settings.nudge_prompt`; service injects today's overdue + due-today todos + active focuses after his prompt before calling LLM. Empty falls back to `DEFAULT_PROMPT`.

Scheduler in FastAPI **lifespan** (not bot script) so config + idempotency are DB-backed and survive bot restarts. Zoneinfo-aware via `Settings.nudge_tz`. `Settings.nudge_last_sent_day` (YYYY-MM-DD) kills double-send if Fly scales to 2.

WhatsApp respects Meta's 24h customer-window: no inbound WA in 24h → skip WA channel. Telegram unconstrained.

Old indexed-list `done <n>` / `tom <n>` / `kill <n>` commands removed. Daniel talks back conversationally.

## Code Patterns

- **Zustand persist**: bump key on shape change (`v1` → `v2`) to avoid stale state
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom
- **FastAPI `db: Session = Depends(get_db)`** — session per request, auto-closed
- **Alembic owns schema**: every mutation = `alembic revision --autogenerate` → `alembic upgrade head`. No `create_all` at runtime. `_alembic_upgrade` runs on boot.
- **Optimistic UI**: `createNote` adds temp note, replaces w/ API response
- **React StrictMode**: kept intentionally; double-fires effects in dev to expose bugs
- **hasChanges ref**: NoteEditor only `save()`s if user actually typed — prevents `updated_at` touched on blur
- **Public routes** `/public` + `/public/$noteId` are standalone (no sidebar, no auth)
- **Images in notes**: base64 inline via TipTap Image extension; large uploads go through `/uploads/image` → R2 URL
- **Deferred embedding columns**: `Note.embedding`, `Note.classified_embedding`, `ListItem.embedding`, `Memory.embedding`, `Message.embedding` wrapped in `deferred()`. List/read endpoints skip the ~31KB-per-row hit. Similarity callers MUST use tuple queries (`db.query(Note.id, Note.embedding).all()`) not `.query(Note).all()` to avoid N+1 lazy-load storm. Pattern in `note_service.search_by_query`, `list_service.find_similar`, `memory_service` retrieval, `focus_synthesizer._gather_messages` (lazy-populates on first read; messages immutable post-create so cache never goes stale)

## Known Issues
