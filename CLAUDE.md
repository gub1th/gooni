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
  1. Before coding: `mcp__gooni__find_similar_items` (threshold 0.78). If exists, `PATCH /backlog/tickets/{id} {"board_status":"doing","claimed_by":"claude"}`. Else create then flip. `claimed_by="claude"` surfaces the 🤖 pill on the board so Daniel can glance and see which tickets Claude is driving.
  2. Working: stays `doing`. Scope shifts → edit the same ticket.
  3. On PR merge: `PATCH /backlog/tickets/{id} {"board_status":"done","pr_url":"..."}`. Backend auto-clears `claimed_by` on done — pill is for live work only.
  4. One ticket per PR; bundled PRs do N sequential PATCHes w/ same pr_url.
  Vocab: legacy `'todo'`/`'in_progress'` was remapped to `'not_yet'`/`'doing'`. Skip only for trivial fixes.

## Current Priorities

See `docs/TODO.md` (gitignored — local only).

## Architecture

### Backend (`app/`)

- **`app/main.py`** — SLIM app wiring only (~490 lines, was 6.5K): the 5 `@app.middleware("http")` blocks (auth Bearer, CORS, req-trace, etc), `add_middleware(CORS)`, `_lifespan`, `_alembic_upgrade`, `_dedupe_singleton_lists`, and `app.include_router()` for every domain router. CORS allows `localhost:5173`. The lifespan runs boot hooks (capability scan, fly-revive) then `create_task`s the background loops. **Background loops live in `app/background.py`** (daily nudge scheduler, list/excerpt backfills, memory watchdog, capability-telemetry + urgency rollups, todo soft-delete sweeper, proactive-nudge tick) — main only starts them. **Routes live in `app/routers/<domain>.py`** (32 `APIRouter` modules — notes/todos/focuses/items/lists/backlog/promises/habits/dashboard/eval/auth/conversations/chat/memories/capabilities/reflections/reactions/comments/settings/integrations/uploads/public/webhooks/mcp/focus_candidates/health/whoop/visits/tool_calls/…). Shared helpers: `app/serializers.py` (`_serialize_*` + note/excerpt/tag helpers), `app/common.py` (date parsers + auth-token + cross-domain validators), `app/deps.py` (nudge fan-out helpers shared by lifespan loops + the settings router). Routers import these; routers never import from `main` (no cycle).
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`.
- **`app/db/models.py`** — SQLAlchemy models. Grep for fields; high-leverage notes only:
  - `Note` — `excerpt` cached preview (≤240 char, HTML/img stripped) populated on save; lazy-backfilled at startup. List endpoints don't ship full body. `status` graduation lifecycle (`unprocessed|graduated|archived`, default `unprocessed`, indexed) — drives the UNPROCESSED sidebar triage queue + synthesizer's source filter. Note becomes `graduated` once it spawns Promise/Todo/Habit/Focus (tracked via `derives_from` edges, wired in PR-E); `archived` is a manual tombstone via `PATCH /notes/{id}` w/ `{"status":"archived"}`. `GET /notes/unprocessed` returns the queue.
  - `Focus` — long-running commitment. Color auto-assigned from 10-color palette. Drift cols: deferred `initial_signature` (frozen at promotion) + `current_signature` (EMA-updated per bind), `missed_run_count` (≥3 → `status='dormant'`), `drift_flagged_at` (one-shot when `1-cos(initial,current) > 0.35`), `evolved_from_focus_id` (lineage via `/focuses/{id}/fork`).
  - `Todo` — 3-state `state` enum (`not_yet|doing|done`), single-FK `focus_id`, singleton `is_primary` (auto-cleared on done).
  - `BacklogTicket` — `board_status` (`not_yet|doing|done`), `pr_url`, `notes` (multi-line body), `todo_id` (FK set on `/promote`), `claimed_by` (free-text agent attribution, e.g. `"claude"` — backs the "🤖 claude picked up" pill; auto-cleared by `backlog_service.update` whenever ticket flips to `done`). Singleton `is_primary` flag (mirrors Todo.is_primary): pinned ticket drives the dashboard north-star banner; auto-cleared on done.
  - `Memory`, `Message`, `Conversation` — embedding cols are `deferred()` (see Code Patterns).
  - `FocusCandidate` — synth-surfaced, lifecycle `proposed → promoted|dismissed`. Upsert key = `cluster_signature` (sha256). Status sticky on re-emit; seen_count bumps.
  - `Reflection` — per-turn self-eval (Reflexion pattern). Sev ≥ 2 + gap → cosine-cluster, 3+ matches at 0.8 auto-promotes a behavioral `CapabilityFacet`.
  - `CapabilityFacet` — Gooni's self-knowledge. UNIQUE `facet_key`. Layers: `mechanical` (boot-scan) / `functional` (manual) / `behavioral` (reflection-promoted) / `architectural` (manual). Status flipped by ToolCall telemetry.
  - `ToolCall` — audit row per chat-tool call. `running → done|failed`. Substrate for anti-hallucination layer.
  - `Promise` — soft commitment uttered in chat ("imma X tonight"). Distinct primitive from Todo (chore) and Focus (long arc). Lifecycle `proposed → pending → kept|broken|abandoned` (auto-broken when `inferred_due` passes). Complex utterances ("no weed for 7 days") land in `state='proposed'` per `promise_complexity.needs_game_plan`; simple utterances ("call mom tomorrow") instant-lock to `pending`. Lock-in flip `proposed → pending` via `PATCH /promises/{id}` with `{"state":"pending"}` — side effect: recurring-shape utterances (per `promise_complexity.is_recurring`) auto-spawn a Habit + write a `measured_by` edge. `slip_count` set on create via cosine match against past broken promises. Cross-links land in `edges` (utters from Message, supports nearest Focus, measured_by Habit when locked-in recurring).
  - `Edge` — graph layer for semantic many-to-many. UNIQUE on `(src_kind, src_id, dst_kind, dst_id, kind)`; bidirectional indexes. v1 kinds: `utters` / `supports` / `closes` / `derives_from` / `mentions`. Ownership FKs stay (Comment.note_id, Memory.source_note_id, Todo.focus_id) — this table handles links that would M²-explode the schema as FK columns.
  - `WaProcessedId` — wamid idempotency for WhatsApp retries.
  - `Attachment` — generic file attached to a Note (PDF, doc, archive, etc.). Stored on R2 under `attachments/`; row holds `filename`, `mime_type`, `size_bytes`, `storage_key`, `public_url`. Distinct from inline images (which live as `<figure>` nodes in note HTML). Inline-card UX via TipTap `attachment` node — same DOM rendered on editor + public view; click opens AttachmentModal (image lightbox / PDF iframe / video / fallback download).
  - `Note.tags` — JSON-text list of free-form labels (lowercase, ≤60 chars each, deduped server-side). Powers cross-cutting views ("from-claude", "feedback", session tags). MCP `add_note` auto-injects `from-claude`. Rendered as small-caps muted chips above the title.
  - `Space.is_pinned` — sidebar pin. Pinned spaces float to top of the spaces list within the user's manual drag-order.
  - `EvalMessageRating.rating` is now nullable — reviewers can save a comment-only row (rating=null + non-empty comment). Empty rows (rating=null AND no comment) are rejected at the route layer. Decoupling fixed the "Daniel typed a note then it disappeared when he picked a rating after" data-loss bug.
  - Singletons: `Space`, `List`, `ListItem`, `PublicProfile`, `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall`, `ClaudeUsageTurn`, `EvalSegment`, `EvalStepFeedback`, `EvalMessageRating`, `WhoopSnapshot`, `LeetcodeSnapshot`, `GooniTake`, `NoteComment`, `Habit`, `HabitEntry`.

- **`app/services/memory_service.py`** — Thin CRUD primitive layer post-phase-3. Exposes `_embed`, `_cosine_search`, `_apply_add/_update/_delete/_none`. Per-candidate reconcile orchestration moved to `intent_handlers/memories.py::_reconcile_one`. `apply_memory_candidates` / `add_exchange` / `add_feedback_preference` are shims that delegate. Retrieval (`build_memory_context_with_debug`) untouched: always-included prefs + top-5 cosine, prepended by `capability_service.build_prompt_block` ("Who I am right now").
- **`app/services/memory_extraction/`** — Package (was a 999-LOC flat module). `__init__.py` re-exports the public API (`extract_signals`, `extract_candidates`, `reconcile_candidate`, `VALID_TYPES`, `_parse_json_object`) so callers import unchanged. Split: `prompts.py` (3 prompt constants incl. the ~430-line `_SIGNALS_PROMPT`), `parsers.py` (json parse + `_validate_candidate`), `normalizers.py` (pure `_normalize_*` dict→dict per signal type), `extract.py` (LLM orchestration). Single LLM call per turn (`extract_signals`) emitting `tone_corrections`, `feature_requests`, `soft_promises`, `todos`, `reply_intent` (`answer|acknowledge|task_only|no_reply`), memory candidates. Regex pre-filter (`_PREFILTER_TRIGGERS`) short-circuits on note-save when text carries no signal-trigger phrases. Chat surfaces bypass prefilter so tone corrections always capture. max_tokens=500.
- **`app/services/intent_router.py`** + **`app/services/intent_handlers/`** — Unified dispatch (note #258 phase 2-5). `intent_router.dispatch(signals, ctx) → RouterResult` is the SINGLE entry point — both `Orchestrator.handle_chat` and `note_service.classify_note` call it. Handlers: `memories.py` (owns reconcile dance), `features.py` (wraps `feature_request_tool` + ticket-id capture), `tones.py` (rule + off-thread `add_feedback_preference`), `promises.py` (wraps `promise_service.create` w/ time-hint composition), `todos.py` (cosine-dedup at 0.85 + due_hint parse). Per-handler try/except. `RouterContext` carries db, source_message_id, source_note_id, prev_assistant_text/id, on_tool_call; handlers self-skip when fields missing (tone on note-save, promise on note-save). `RouterResult.reply_intent` propagates; orchestrator short-circuits LLM reply on `task_only` / `no_reply`.
- **`app/services/reflexion_service.py`** — Per-turn Reflexion (Shinn et al.). Daemon thread w/ own SessionLocal after each assistant Message. Cost ~$0.0001/turn. Hook in `orchestrator/core.py` after normal-reply AND short-circuit feedback_ack (highest-leverage spot: "logged but didn't act" failure mode).
- **`app/services/capability_service.py`** — Owns `capability_facets`. `refresh_mechanical_layer` runs at lifespan start (walks tool registry + routes + messaging channels). `run_telemetry_rollup` daily 03:00 — counts ToolCall rows, flips verified/unverified/broken. `build_prompt_block` formats functional/behavioral/architectural layers (mechanical implicit in function schemas), capped at 30 lines.
- **`app/services/orchestrator/`** — Package (split from the former single 2.3K-line file; pure mechanical refactor, behavior-identical). `core.py` = `Orchestrator` class + `handle_chat` + `PERSONA_BLOCK`; `prompt_blocks.py` = `_build_*` master-prompt block builders + `OBJECT_KINDS_BLOCK` + `_summarize_entry`; `steps.py` = ReAct plan/verify (`_run_plan`, `_run_verify`, `_deterministic_unbacked_check`, `_strip_memory_anchors`). `__init__.py` re-exports `Orchestrator` so callers import unchanged. Unified chat across web/telegram/whatsapp/imessage. `Orchestrator` singleton. Bot channels = single persistent conv per source. Each turn builds `TraceBuilder` trace stamped on `Message.trace`. `extract_signals` fans out via `intent_router.dispatch` (single dispatch — replaces inline if-chains). All channels get `OBJECT_KINDS_BLOCK` (auto-derived once at module import from `tools/__init__.py` registry × `_CREATE_TOOL_KINDS` map + `_ROUTER_CREATED_KINDS` — currently Memory, ListItem, Note, Todo, Focus, HabitEntry, BacklogTicket, CalendarEvent, Promise) injected directly under PERSONA as anti-hallucination anchor. Bot turns also get four master-prompt blocks: `cadence_block` (Alfred voice rules — 1 bubble default, 2 max, ≤3-word acknowledge when criticized, action > preface, no self-flagellation), `state_block` (`[your state right now]` — primary todo + open/done counts + pending promises ≤24h with slip_count), `just_extracted_block` (`[just extracted from this message — already routed, don't re-announce]` — tone rules / `BacklogTicket #N` / `Promise #N` / `Todo #N` lines w/ real ids so the PERSONA "no tracked-without-id" rule has something concrete to cite). `_build_ack` (alias `_build_jarvis_ack`) composes terse alfred-voice acknowledgements from structured `captured_features` / `captured_promises` / `captured_todos` dicts; multi-feature renders comma-joined ticket ids instead of opaque `(+N)`. Reply-intent `task_only`/`no_reply` short-circuits the LLM reply step.
- **`app/services/promise_service.py`** — Promise CRUD + lifecycle. `create()` runs `promise_complexity.needs_game_plan` on the utterance — `True` → state='proposed' (awaiting lock-in), `False` → state='pending' (instant-lock). Infers deadline via `_infer_due_from_text` (regex over "tonight"/"tomorrow"/etc), embeds utterance, auto-wires `utters` edge from source Message + `supports` edge to nearest cosine-matched active Focus (≥ 0.75). `slip_count` set on create via cosine match against past `broken` promises (≥ 0.80). Then runs `promise_evaluator.evaluate` and tags any verdict on the in-memory Promise as `_voice_of_reason` (serialized as `voice_of_reason` dict). `auto_mark_overdue` sweeps stale **pending** → broken (proposed never auto-breaks). `transition()` is the only state mutator; `proposed → pending` triggers `_maybe_auto_create_habit` which spawns a Habit + `measured_by` edge when `promise_complexity.is_recurring` matches the utterance.
- **`app/services/promise_evaluator.py`** — Voice-of-reason push-back. Four deterministic checks per new Promise: coupled-reward (regex over "if/when/after … i can/have/deserve <reward>"), conflicts-active (cosine ≥ 0.85 vs active pending promises), too-vague (no concrete verb AND no anchor), track-record-doubt (`slip_count ≥ 3`). Returns `{flags, primary, suggestion, details}` or `None`. Templates per primary flag — no LLM. Surfaces in ack (appended to promise phrase) + `[just extracted]` block.
- **`app/services/edge_service.py`** — Generic graph layer over `edges`. Module-level helpers (no class): `link()` (idempotent on 5-tuple), `unlink()`, `links_for()` (bidirectional traversal), `neighbors(direction='out'|'in'|'any')`, `serialize_edge()`. Service-layer callers wire kinds at create time (e.g. promise_service wires `utters`/`supports`; list_service.add_item wires `list_item supports focus` when a new item cosine-matches an active focus ≥ 0.75).
- **`app/services/list_enrich.py`** — Async venue enrichment for places-shaped lists. `list_service.add_item` calls `maybe_enrich_item(item_id, list_id)` after insert; gates on `_looks_places_shaped(list.name)` regex (places/spots/restaurants/bars/venues/eats/date/coffee/cocktails/hot list/etc.) + empty subtitle. Daemon thread w/ own SessionLocal calls Tavily `web_search` then `gpt-4o-mini` summary, PATCHes subtitle in place (≤200 chars). Re-checks subtitle before commit so a manual edit racing the thread wins. All failures silent (no Tavily key, empty result, network blip → no-op). Single attempt — no retries.
- **`app/services/fly_revive.py`** — Boot-time handshake. `catch_up_orphaned_messages(db)` finds WA convs where most-recent msg is user within 24h + no assistant reply after, sends brief "fly died, back online" apology via `whatsapp_channel.send()` and records it as assistant Message. Idempotent automatically (once apology lands the orphan tail is gone). v1 doesn't re-process the orphan through orchestrator.
- **`app/tools/`** — LLM function-calling surface (~25 tools): memory, web, lists, notes, todos (3-state), focuses, habits (fuzzy name resolve, refuses unknown), feature_request, activity (`read_recent_commits` per-repo subjects across tracked GitHub repos, `read_recent_backlog` tickets grouped by status with PR links), calendar (5). Destructive tools (delete/forget/edit-memory/backlog ops) deliberately NOT exposed to chat — SMS typos shouldn't wipe data. Dev-only tools stay in `mcp/server.py`.
- **`app/services/trace_builder.py`** — `TraceBuilder` + `PROMPT_VERSION`. Bump version when orchestrator flow / master prompt / memory pipeline change so eval ratings filter cleanly.
- **`app/services/eval_service.py`** — Eval loop. Segments conversations (web = 1 conv = 1 segment; bots sliced by `EVAL_GAP_HOURS`, default 4). `get_segment_full` joins ToolCall audit per message (trace = intended, audit = actual). Dispatches to Claude Code space note + backlog item (idempotent re-dispatch). TipTap-compatible HTML only (no `<details>` — silently dropped by StarterKit).
- **`app/services/focus_synthesizer.py`** — Probe-quality focus surfacer. Gather → embed (cached on `Message.embedding`) → greedy cosine cluster → pairwise merge → sub-cluster → classify (`focus|state|noise`) → state→focus binding (absolute floor 0.38 + 0.10 margin). Pure probe, no DB writes. `POST /focus-synthesis/run`. `_gather_notes` filters `Note.status == 'unprocessed'` so already-graduated notes don't re-surface as fresh focus candidates.
- **`app/services/focus_candidate_service.py`** — `FocusCandidate` lifecycle. `persist_run` upserts by `cluster_signature`. `promote()` creates Focus, stamps initial+current signature = candidate centroid, then calls `_graduate_evidence_notes` which walks `evidence_json` for note rows, writes `derives_from` edge (note → focus) per match, and flips `Note.status='graduated'` (idempotent; skips already-graduated/archived). State/noise clusters NOT persisted.
- **`app/services/focus_service.py`** — Focus CRUD + hybrid binding (`bind_to_clusters`). Each synth run: cosine ≥ 0.70 match (1-to-1, desc sim) → EMA-blend (α=0.7 old, 0.3 new) → refresh evidence + last_seen. Unbound active focuses bump `missed_run_count`; ≥3 → dormant. Drift flagged when `1-cos(initial,current) > 0.35`. `rename` snaps initial := current + clears flag. `fork` flips old to evolved + spawns new w/ lineage link.
- **`app/services/habit_service.py`** — Habit CRUD + entry upsert + streak / 7-day-strip. Streak forks on polarity: `positive` = consecutive True walking back (one grace day for unlogged today; False/gap breaks); `negative` (avoidance) = days since last True (sober-tracker pattern; counts from habit creation when no slip recorded). `find_by_name_fuzzy` = case-insensitive substring. Value semantics never invert: True always means "did the literal action" regardless of polarity.
- **`app/services/health_service.py`** — 6-axis composite scoring (memory/chat/engagement/availability/cost/connectors). Each axis: 0-100 composite + per-component breakdown. Try/except per axis — one failure can't take down dashboard. `PROCESS_START_MONOTONIC` stamped at import for uptime.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound`. Per-channel impls own outbound formatter, allowlist, send client. Returns `(raw, [segments])` — replies split into 1-2 short bubbles (≤320 char each) via `split_for_bots`. `_MIN_SEGMENT_CHARS=18` so short paragraphs aren't merged. `_MAX_SEGMENTS=2` enforces terseness (was 4; master-prompt does the heavy lift, this is the safety net). Sentence regex `(?<=[.!?])\s+(?=\S)` (was `(?=[A-Z])`) so lowercase-casual paragraphs split correctly. Web doesn't use this (stays unsplit).
- **`app/services/note_service.py`** — Embedding + space suggest + related notes (OpenAI embeddings, cosine).
- **`app/services/take_service.py`** — Daily LLM takes (`GooniTake`, kind=focus|dev). `PROMPT_VERSIONS` per kind; stale rows auto-regenerate. Empty takes not persisted (keeps yesterday alive when source is empty). **Dev take = JSON** (v3): array of `{theme, summary}`, max 5. Frontend `parseDevTake` handles legacy v2 prose.
- **`app/services/todo_nudge.py`** — Daily morning digest. Picks ONE thing (priority: promise due within 24h → any pending promise → primary todo → most-overdue todo) and asks conversationally. Sweeps `promise_service.auto_mark_overdue` first. Voice instruction enforces friend-texting cadence; falls back to static one-liner if LLM fails.
- **`app/services/proactive_nudge.py`** — Proactive Gooni phase 0. Two deterministic WhatsApp pings: `maybe_fire_whoop_nudge(row, db)` (queued by `whoop.upsert_today_snapshot`'s post-commit hook — writes the candidate snapshot's `source_updated_at` to `Settings.whoop_nudge_pending_source_ts` + stamps `whoop_nudge_pending_set_at`; doesn't send inline) and `maybe_fire_sleep_nudge(db)` (lifespan tick; fires when local hour ≥ `Settings.sleep_cutoff_hour` (default 1) AND active signal (msg/claude turn/note) in last 15 min AND not already pinged tonight; idempotent on `Settings.last_sleep_nudge_day`). The whoop send happens via `process_pending_whoop_nudge` — debounced ≥3 min after the last `pending_set_at` update so webhook bursts (recovery + cycle + sleep arriving within seconds) collapse to one ping carrying the LATEST snapshot data. `_proactive_nudge_loop` in `app/background.py` ticks every 60 s and calls both checks. Channel hardcoded to WhatsApp (first handle from `WHATSAPP_ALLOWED_HANDLES`).
- **Greeting fast-path** — bare greetings like "hey" / "hey gooni" / "wsg" / "yo!" / "gm" match `Orchestrator._GREETING_RE` at the top of `handle_chat`, bypassing extract_signals + router + memory + plan + verify + reflexion. Single `gpt-4o-mini` call against PERSONA + last 4 messages (`_handle_greeting_fast`). Saves ~$0.03 + ~5 s per greeting. Anything compound ("hey gooni whats on my plate") fails the regex and falls through to the full pipeline.
- **Tool-history in recent_history** — `orchestrator.handle_chat` joins `ToolCall` rows by `message_id` for the last 10 assistant messages and inlines `[tools you actually called this turn: list_todos, list_recent_notes]` into the assistant content before feeding history to the LLM. Fixes the conv-#1155 failure mode where Gooni denied calling `list_recent_notes` despite having done so the prior turn — history previously stripped tool calls so the model had amnesia about its own actions.
- **`app/services/image_storage.py`** — Cloudflare R2 uploader. `POST /uploads/image`. `R2NotConfigured` → 503 → frontend falls back to inline base64.
- **`app/llm/client.py`** — OpenAI wrapper. Default `gpt-4o-mini`. `_execute_with_audit` writes ToolCall rows; failures logged + swallowed (never breaks chat path).

### Frontend (`frontend/src/`)

Index of files. Internals grep-able.

- **`ui/`** — Design system (single source of truth). `tokens.ts` (`FONT`, `color` object — theme tokens resolve to `--gooni-*` CSS vars w/ light fallback, plus semantic accents; `scrim`, `radius`, `space`, `fontSize`, `z`), `Button` (variants primary/accent/ghost/danger/subtle), `Card`, canonical `Modal` (overlay+card chrome, Esc/backdrop/× close, scroll-lock, autofocus). Barrel `index.ts` — `import { Modal, Button, color, FONT } from "../ui"`. Styling is inline `style={{}}` (no CSS framework; `@emotion` is an unused dep). **Don't hardcode `#hex` or redeclare `FONT` — import tokens.** Migration is partial: foundation + FONT (all files) + the two gray families (`#8e8e93`/`#9ca3af` → `color.muted`) done; most modals + many colors still inline (incremental adoption). Theme-store palette (`useGooniThemeStore`) is the ONE place raw hex lives — it *defines* the tokens.
- **Themes** — light + dark only (`GooniTheme`, `useGooniThemeStore`). Legacy 5 light variants (cool/warm/mint/rose/slate) collapsed → `light`; stored values normalize. Palette pushes `--gooni-*` vars in `routes/__root.tsx`; both themes define the full token set. SettingsModal Appearance tab toggles them.
- **`routes/index.tsx`** — Top-level layout. View state: `"notes"|"dashboard"|"chat"|"lists"|"eval"|"stats"`. Fixed top-right icon pair (Globe = public, Plug = MCP).
- **`routes/public.tsx`, `public.index.tsx`, `public.$noteId.tsx`** — Standalone public portfolio (no sidebar, no auth).
- **`components/eval/EvalView.tsx`** — Eval tab. Per-source border + badge, filters, segment detail w/ trace cards + ToolCall audit + red-flag popover + dispatch-to-Claude-Code.
- **`components/notes/Sidebar.tsx`, `NotesList.tsx`, `NoteEditor.tsx`** — Sidebar 200px (draggable Notes/Chat sections), list 260px, editor (TipTap, auto-save 1.5s, image drag/paste). TipTap extensions: SlashCommand (`/`), NoteMention (`@` → note picker, `note-mention.ts` + `NoteMentionMenu.tsx`, inserts a `NoteLink` chip via `searchNoteTitles`), NoteCard (block callout — `NoteCardExtension.ts`, full-width panel w/ left check, `toggleWrap`), NoteLink (inline chip → internal nav), LinkCard (URL → OG preview), ToggleBlock, TextColor.
- **`components/ChatView.tsx`** — Full chat. Text-only streams via SSE (`/messages/stream`); image turns + bots stay blocking.
- **`components/Dashboard.tsx`** — Single-column. Mode toggle (Today|Ops|Stats, key `gooni-dashboard-v3`, migrate maps legacy `build`→`ops` and `pulse`→`stats`). Today body reacts to `composerFocused` (collapses TakeTabs, dims focuses/todos block).
- **`components/dashboard/`** — TodoList (3-state cycle), DashboardHeader, TabToggle, FocusesView (SynthesizerSection + FocusCard grid), FocusCard (normal/drifting/dormant states + lineage), SynthesizerSection (candidate pills, ✓/✗, ↻), FocusDrillDown (modal), HabitsStrip (7-cell tracker + streak), ModeToggle, BuildMode (health cards, folded into OpsMode), OpsMode (no sub-tabs — stacked sections: BacklogSection + BuildMode + CapabilityProfileCard + FailuresSection; eval workflow lives only in `routes/chat-audit.tsx` + `EvalView`), StatsMode (merged Pulse + StatsView page sections: Whoop / Streaks / Dev Activity / LeetCode / Usage / Activity counters), HealthCard, HealthDrillDown.
- **`components/StatsView.tsx`** — Section module. Exports `WhoopSection`, `LeetcodeSection`, `DevSection`, `ActivitySection`, `SectionShell`, `BigStat`, `SkeletonRow`, `relTime`, `fmtInt` for re-use by `StatsMode`. The top-level `StatsView` component is no longer routed; the sidebar Stats entry was removed in the dashboard restructure.
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
**Backlog tickets** (own table): `read_backlog`, `add_backlog_item` (conflict scan via `POST /backlog/tickets/similar`), `find_similar_backlog`, `set_backlog_state` (flip not_yet/doing/done), `complete_backlog_item` (pr_url closes lifecycle), `delete_backlog_item`, `promote_backlog_to_primary` (singleton north-star banner), `clear_primary_backlog`

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

**Half-applied-state recovery** (post-PR #234 prod crash-loop): `_alembic_upgrade` catches `OperationalError: ... already exists / duplicate column`, stamps the cursor to head, and continues boot. SQLite auto-commits DDL the moment a `CREATE TABLE` runs, so if the process dies before the alembic version-stamp UPDATE lands, the next boot re-runs the migration and crashes on the existing table. The hardening lets the app self-heal instead of crash-looping. Other `OperationalError` shapes (bad column type, missing FK) still propagate — only the "already exists" branch is treated as self-recoverable.

**Migration-author convention:** for `CREATE TABLE` / `ADD COLUMN` migrations, prefer inspector guards so re-runs are no-ops:
```python
def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table('foo'):
        op.create_table('foo', ...)
```
The `_alembic_upgrade` recovery catches what slips through, but inspector-guarded migrations are self-healing by design.

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
GET    /notes/search-titles?q=&limit=8 → cheap title-substring search (no embedding), recency-ordered, list-shape. Powers the @-mention note picker. Empty q → recent notes. Distinct from semantic /mcp/notes/search.

# Comments
GET    /notes/{id}/comments
POST   /notes/{id}/comments           → { content, author? }
DELETE /comments/{id}

# Uploads
POST   /uploads/image                 → multipart → R2 → { url, key }. 503 when R2 env unset → FE falls back to inline base64. 10 MB, image/* only.
POST   /uploads/file                  → multipart → R2 (`attachments/YYYY/MM/DD/...`) → { url, key, filename, mime_type, size_bytes, attachment_id? }. Optional `note_id` form field creates an `attachments` row (else upload is orphan-tolerable). 25 MB cap, any MIME. 503 when R2 env unset (no base64 fallback for opaque files).
GET    /promises?state=proposed|pending|kept|broken|abandoned&limit=50 → list w/ deadline-asc sort for pending, recency for everything else
GET    /promises/pis                  → Promise Integrity Score (weighted aggregate over last 20 resolved: kept +1, broken -1.5, abandoned -0.5). Returns { score: 0-100 | null, sample_size, kept_streak, last_broken_at, last_broken_summary, weights, window }. Null score when sample_size < 3 (small-N noise distortion).
PATCH  /promises/{id}                  → { state: proposed|pending|kept|broken|abandoned }. Idempotent — re-sending current state is a no-op. Lock-in flip proposed→pending auto-spawns Habit when utterance is recurring-shaped.
GET    /uploads/og?url=...            → server-side Open Graph scraper (og:title/description/image/site_name + fallbacks). Used by TipTap LinkCard node so the browser doesn't expose its IP. Graceful degrade to { url, title:url } on any fetch error.
GET    /notes/{id}/attachments        → list rows for that note
DELETE /attachments/{id}              → drops DB row (R2 object kept; future sweeper reconciles)

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
GET    /focuses                       → active, w/ color + linked-todo progress {done,total}. Drives FocusesView's FocusCard grid.
GET    /focuses/{id}                  → detail incl. parsed evidence array. Drives FocusDrillDown.
POST   /focuses                       → { name, commitment, due_date? }
POST   /focuses/{id}/rename           → snaps initial := current, clears drift flag. { text?, endgoal? }
POST   /focuses/{id}/fork             → old → evolved, new inherits drifted current as initial+current, links via evolved_from_focus_id. { new_text, new_endgoal? }
POST   /focuses/{id}/reactivate       → dormant → committed. Clears missed_run_count + drift flag.

# Todos
GET    /todos                         → bucketed { primary, open, done_today }. open sorted doing > not_yet.
POST   /todos                         → { text, focus_id?, due_date?, subtitle?, state? }
PATCH  /todos/{id}                    → { text?, subtitle?, state?, focus_id?, is_primary?, due_date?, sort_order?, done?, closure_note? }. state=done auto-clears primary + syncs linked backlog ticket. `closure_note` editable post-close via the chain-view inline note editor.
POST   /todos/{id}/cycle              → not_yet → doing → done. From done, FE pops picker (programmatic cycle bounces to not_yet).
POST   /todos/{id}/promote-to-primary → singleton. Idempotent.
DELETE /todos/{id}                    → also clears backlog_tickets.todo_id

# Backlog promote/demote
POST   /backlog/tickets/{id}/promote  → idempotent. Creates Todo mirroring text/subtitle, stores ticket.todo_id.
POST   /backlog/tickets/{id}/demote   → deletes linked Todo, clears todo_id. Ticket stays.

# Backlog primary (singleton north-star banner)
GET    /backlog/tickets/primary             → currently-pinned ticket or null. Excludes done tickets.
POST   /backlog/tickets/{id}/promote-to-primary → set as singleton primary; atomically clears prior primary. Idempotent.
POST   /backlog/tickets/primary/clear       → unpin whichever ticket is primary. Returns demoted ticket or null.

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
