# CLAUDE.md

> Project-specific rules + index. Behavioral defaults (about Daniel, lock-goal, verify-before-push, keep-docs-honest) live in global `~/.claude/CLAUDE.md` — not duplicated here.

## Goal

Gooni = personal AI notebook → ambient home assistant. Loop:
1. Write notes (Apple Notes layout: spaces → list → editor)
2. Gooni (gpt-5.4) reads active note, answers / gives feedback
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
  1. Before coding: `mcp__gooni__find_similar_items` (threshold 0.78). If exists, `PATCH /backlog/tickets/{id} {"board_status":"doing","claimed_by":"claude"}`. Else create then flip. `claimed_by="claude"` surfaces the 🤖 pill on the board.
  2. Working: stays `doing`. Scope shifts → edit the same ticket.
  3. On PR merge: `PATCH /backlog/tickets/{id} {"board_status":"done","pr_url":"..."}`. Backend auto-clears `claimed_by` on done.
  4. One ticket per PR; bundled PRs do N sequential PATCHes w/ same pr_url.
  Vocab: legacy `'todo'`/`'in_progress'` remap to `'not_yet'`/`'doing'`. Skip only for trivial fixes.

## Current Priorities

See `docs/TODO.md` (gitignored — local only).

## API surface

Route shapes are grep-able — every domain is one `app/routers/<domain>.py` module (`@router.<verb>` decorators). Request/response serialization lives in `app/serializers.py` (`_serialize_*`). Non-obvious endpoint semantics are noted inline at the model/service that owns them, below.

## Architecture

### Backend (`app/`)

- **`app/main.py`** — SLIM wiring only (~520 lines): 5 `@app.middleware("http")` blocks (auth Bearer, CORS, req-trace), `add_middleware(CORS)` (allows `localhost:5173`), `_lifespan`, `_alembic_upgrade`, `_dedupe_singleton_lists`, `include_router()` per domain. Lifespan runs boot hooks (capability scan, fly-revive) then `create_task`s background loops. **Background loops live in `app/background.py`** (daily nudge scheduler, list/excerpt backfills, memory watchdog, capability-telemetry + urgency rollups, todo soft-delete sweeper, proactive-nudge tick, 5am batch processor) — main only starts them. **Routes live in `app/routers/<domain>.py`** (34 `APIRouter` modules). Shared helpers: `app/serializers.py`, `app/common.py` (date parsers + auth-token + cross-domain validators + `local_today(db)` — canonical tz-aware "today" in `Settings.nudge_tz`; NEVER use `date.today()` for user-facing calendar days, server runs UTC), `app/deps.py` (nudge fan-out, shared by lifespan loops + settings router). Routers never import from `main` (no cycle).
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`.
- **`app/db/models.py`** — SQLAlchemy models. Grep for fields; high-leverage notes only:
  - `Note` — `excerpt` cached preview (≤240 char, HTML/img stripped) populated on save, lazy-backfilled at startup; list endpoints don't ship full body. `status` graduation lifecycle (`unprocessed|graduated|archived`, default `unprocessed`, indexed) drives the UNPROCESSED sidebar triage queue + synthesizer source filter. Becomes `graduated` once it spawns Promise/Todo/Habit/Focus (via `derives_from` edges); `archived` = manual tombstone. `GET /notes/unprocessed` returns the queue.
  - `Focus` — long-running commitment. Color auto-assigned from 10-color palette. Drift cols: deferred `initial_signature` (frozen at promotion) + `current_signature` (EMA-updated per bind), `missed_run_count` (≥3 → `status='dormant'`), `drift_flagged_at` (one-shot when `1-cos(initial,current) > 0.35`), `evolved_from_focus_id` (lineage via `/focuses/{id}/fork`).
  - `Todo` — 3-state `state` enum (`not_yet|doing|done`), single-FK `focus_id`, singleton `is_primary` (auto-cleared on done). `doing_started_at` stamped on entry to `doing` / cleared on exit; `last_nudge_sent_at` debounces the procrastination nudge.
  - `BacklogTicket` — `board_status` (`not_yet|doing|done`), `pr_url`, `notes` (multi-line body), `todo_id` (FK set on `/promote`), `claimed_by` (free-text agent attribution, e.g. `"claude"` — backs the 🤖 pill; auto-cleared by `backlog_service.update` on flip to `done`). Singleton `is_primary` (mirrors Todo): pinned ticket drives dashboard north-star banner; auto-cleared on done.
  - `Memory`, `Message`, `Conversation` — embedding cols are `deferred()` (see Code Patterns).
  - `FocusCandidate` — synth-surfaced, lifecycle `proposed → promoted|dismissed`. Upsert key = `cluster_signature` (sha256). Status sticky on re-emit; seen_count bumps.
  - `Reflection` — per-turn self-take, now DETERMINISTIC (no LLM judge — see `reflexion_service`). Row written only when a hard guard trips (hallucinated write / voice-spec regex); sev ≥ 2 + gap → cosine-cluster, 3+ matches at 0.8 auto-promotes a behavioral `CapabilityFacet`. Table kept for history; most turns write nothing.
  - `CapabilityFacet` — Gooni's self-knowledge. UNIQUE `facet_key`. Layers: `mechanical` (boot-scan) / `functional` (manual) / `behavioral` (reflection-promoted) / `architectural` (manual). Status flipped by ToolCall telemetry.
  - `ToolCall` — audit row per chat-tool call. `running → done|failed`. Anti-hallucination substrate.
  - `Promise` — soft commitment uttered in chat ("imma X tonight"). Distinct from Todo (chore) and Focus (long arc). Lifecycle `active → kept|broken` (auto-broken when `inferred_due` passes); every utterance lands `active` immediately. `promise_complexity.needs_game_plan` stamps `needs_clarification` metadata (drives ack pushback; doesn't gate state). Recurring-shape utterances (per `promise_complexity.is_recurring`) auto-spawn a Habit + `measured_by` edge at create time. `slip_count` set on create via cosine match vs past broken promises. Cross-links land in `edges` (utters from Message, supports nearest Focus, measured_by Habit when recurring). Manual-add: `POST /promises {text}` (dashboard PromiseDrawer) routes through same `promise_service.create`, minus the source-message `utters` edge.
  - `Edge` — graph layer for semantic many-to-many. UNIQUE on `(src_kind, src_id, dst_kind, dst_id, kind)`; bidirectional indexes. Kinds: `utters` / `supports` / `closes` / `derives_from` / `mentions`. Ownership FKs stay (Comment.note_id, Memory.source_note_id, Todo.focus_id); this table handles links that would M²-explode as FK columns.
  - `LimboItem` — raw staging primitive (the antecedent layer typed primitives are born from). Written by the 5am batch from ambiguous brain-dump threads (`status` limbo|promoted|dismissed, `mention_count`, `kind_hint` idea|context, `promoted_to_type`/`promoted_to_id`, deferred `embedding`). Composes with `FocusCandidate`, doesn't replace it — a LimboItem is one raw thought; the synth clusters them into FocusCandidates. Real-time captures (todo/promise/fitness) do NOT pass through limbo; raw `Message` rows are the durable capture, LimboItems are derived. `promote` → focus|todo|promise|memory + `derives_from` edge. See `limbo_service` + `batch_service`.
  - `DailyMetric` — numeric/text daily tracking (`metric_type`: `calories|protein|weight|exercise|alcohol|weed|vape|note`, `value` float, `unit`, `date`, `notes`). Adding a type needs NO migration — `metric_type` is a free string col. Standalone from `Habit`/`HabitEntry` (which stay boolean) — substrate for the cut table, which OWNS its grid (substance streaks like "N days no weed" are derivable from row history later; no Habit needed — keeps cut tracking ONE system). NO unique constraint: calories/protein are ADDITIVE within a day (SUM); weight/alcohol/weed/vape are last-write-wins (newest by `created_at`); exercise = presence sentinel `value=1.0` + label in `notes`; note = freeform text in `notes` (newest wins). Logged real-time by the chat fitness handler (additive); the cut-table cell edit / backfill uses `set_cell` which COLLAPSES a (date,type) to one row (idempotent override). See `daily_metric_service`.
  - `WaProcessedId` — wamid idempotency for WhatsApp retries.
  - `Attachment` — generic file on a Note OR a Todo (PDF/doc/archive). On R2 under `attachments/`; row holds `filename`/`mime_type`/`size_bytes`/`storage_key`/`public_url`. Owner is exactly one of `note_id`/`todo_id` (both nullable FKs; one extra owner ≠ polymorphic rework yet). Distinct from inline images (`<figure>` nodes in note HTML). Note UX = inline TipTap `attachment` node → AttachmentModal; todo UX = dropzone in TodoEditModal. Upload `POST /uploads/file` (`note_id`|`todo_id` form field); list `GET /{notes|todos}/{id}/attachments`; `DELETE /attachments/{id}` (DB row only, leaves R2 object).
  - `Note.tags` — JSON-text list of free-form labels (lowercase, ≤60 chars, deduped server-side). Powers cross-cutting views. MCP `add_note` auto-injects `from-claude`. Rendered as small-caps chips above title.
  - `Space.is_pinned` — sidebar pin; floats to top within manual drag-order.
  - `EvalMessageRating.rating` nullable — reviewers can save comment-only (rating=null + non-empty comment). Empty rows rejected at route layer.
  - Singletons: `Space`, `List`, `ListItem`, `PublicProfile`, `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall`, `ClaudeUsageTurn`, `EvalSegment`, `EvalStepFeedback`, `EvalMessageRating`, `WhoopSnapshot`, `LeetcodeSnapshot`, `GooniTake`, `NoteComment`, `Habit`, `HabitEntry`.

- **`app/services/memory_service.py`** — Thin CRUD primitives: `_embed`, `_cosine_search`, `_apply_add/_update/_delete/_none`. Per-candidate reconcile lives in `intent_handlers/memories.py::_reconcile_one`; `apply_memory_candidates`/`add_exchange`/`add_feedback_preference` are delegating shims. Retrieval (`build_memory_context_with_debug`): always-included prefs + top-5 cosine, prepended by `capability_service.build_prompt_block`.
- **`app/services/memory_extraction/`** — Package. `__init__.py` re-exports public API (`extract_signals`, `extract_candidates`, `reconcile_candidate`, `VALID_TYPES`). Split: `prompts.py` (incl. ~430-line `_SIGNALS_PROMPT`), `parsers.py`, `normalizers.py`, `extract.py`. Single LLM call per turn (`extract_signals`) emits `tone_corrections`, `feature_requests`, `soft_promises`, `todos`, `done_signals`, `fitness_logs` (diet/body/training/substance → DailyMetric rows; `log_type` food|weight|exercise|macros_explicit|substance + `needs_estimation` flag for food w/o numbers; `substance` ∈ alcohol|weed|vape flips a boolean cut cell; optional `date` resolved from relative phrasing for backdating), `reply_intent` (`answer|acknowledge|task_only|no_reply`), memory candidates. Regex pre-filter (`_PREFILTER_TRIGGERS`) short-circuits note-save when no trigger phrases (incl. fitness triggers); chat surfaces bypass prefilter. `_MACRO_ESTIMATE_PROMPT` is a separate tiny call fired ONLY by the fitness handler for food-without-numbers. `gpt-5.4-mini`, max_tokens=500. **Prefilter caveat:** `extract_signals` short-circuits to empty (no LLM) when `prev_assistant is None` AND no `_PREFILTER_TRIGGERS` match — chat ALWAYS passes `prev_assistant` so it bypasses; only the note-save path can be gated.
- **`app/services/intent_router.py`** + **`app/services/intent_handlers/`** — Unified dispatch. `intent_router.dispatch(signals, ctx) → RouterResult` is the SINGLE entry point — both `Orchestrator.handle_chat` and `note_service.classify_note` call it. Handlers: `memories.py` (reconcile dance), `features.py` (feature_request_tool + ticket-id capture), `tones.py` (rule + off-thread `add_feedback_preference`), `promises.py` (promise_service.create w/ time-hint), `todos.py` (cosine-dedup 0.85 + due_hint parse), `fitness.py` (DailyMetric rows + running-total stamp + generic `exercise` HabitEntry dual-write on any workout — gym/tennis/run all → one "trained today" streak, activity kept in the label; real-time, not batched. Also `substance` logs → `set_cell(today, alcohol|weed|vape, value=1)` boolean — DailyMetric only, NO Habit). Per-handler try/except. `RouterContext` carries db, source_message_id, source_note_id, prev_assistant_text/id, on_tool_call; handlers self-skip when fields missing. `RouterResult.reply_intent` propagates; orchestrator short-circuits LLM reply on `task_only`/`no_reply`.
- **`app/services/reflexion_service.py`** — Per-turn self-take, DETERMINISTIC only (the gpt-4o-mini self-judge was removed — a weak model asked "what's wrong" manufactured sev2 noise + echoed prior turns). `reflect()` writes a `Reflection` row ONLY when a ground-truthable guard trips: hallucination cross-ref (a write-claim regex — "tracked"/"logged"/"saved" — with no `ToolCall` row AND `routed.wrote_anything()` false → sev3) or voice-spec regex (bot-register / character-attack / doubled-down → sev2). No guard → no row. Rows still embed + feed behavioral-facet clustering. Daemon thread, own SessionLocal, never blocks chat. `router_wrote` threaded from `orchestrator/core.py` (router captures aren't ToolCall rows). `rollup_conversation` (manual `POST /reflections/rollup-now`) still uses an LLM but fires rarely now.
- **`app/services/capability_service.py`** — Owns `capability_facets`. `refresh_mechanical_layer` at lifespan start (walks tool registry + routes + channels). `run_telemetry_rollup` daily 03:00 — counts ToolCall rows, flips verified/unverified/broken. `build_prompt_block` formats functional/behavioral/architectural (mechanical implicit in function schemas), capped 30 lines.
- **`app/services/orchestrator/`** — Package (split from former 2.3K-line file; behavior-identical). `core.py` = `Orchestrator` + `handle_chat` + `PERSONA_BLOCK`; `prompt_blocks.py` = `_build_*` block builders + `OBJECT_KINDS_BLOCK` + `_summarize_entry`; `steps.py` = ReAct plan/verify. Unified chat across web/telegram/whatsapp/imessage; singleton. Bot channels = single persistent conv per source. Each turn builds `TraceBuilder` trace on `Message.trace`. `extract_signals` fans out via `intent_router.dispatch`. All channels get `OBJECT_KINDS_BLOCK` (auto-derived at import from tool registry × `_CREATE_TOOL_KINDS` + `_ROUTER_CREATED_KINDS`) under PERSONA as anti-hallucination anchor. Bot turns also get: `cadence_block` (Alfred voice — 1 bubble default, 2 max), `state_block` (`[your state right now]` — primary todo + counts + active promises ≤24h w/ slip_count), `just_extracted_block` (already-routed `BacklogTicket #N`/`Promise #N`/`Todo #N` lines w/ real ids so PERSONA's "no tracked-without-id" rule has something to cite). `_build_ack` composes terse acks from `captured_features`/`captured_promises`/`captured_todos`. `task_only`/`no_reply` short-circuits the LLM reply.
- **`app/services/promise_service.py`** — Promise CRUD + lifecycle. `create()` always lands `state='active'`. Runs `promise_complexity.needs_game_plan`, stores as `needs_clarification` metadata (drives ack pushback, doesn't gate state). Infers deadline (`_infer_due_from_text` regex), embeds utterance, active-dedups (cosine ≥ threshold returns existing row), wires `utters` edge from source Message (when present) + `supports` edge to nearest active Focus (≥0.75). `slip_count` via cosine vs past `broken` (≥0.80). Recurring-shape utterances auto-spawn Habit + `measured_by` edge at create time (`_maybe_auto_create_habit`). Runs `promise_evaluator.evaluate`, tags verdict as `_voice_of_reason`. `auto_mark_overdue` sweeps stale **active** → broken. `transition(active|kept|broken)` = only state mutator (kept/broken stamp `resolved_at`; reviving to active clears it).
- **`app/services/promise_evaluator.py`** — Voice-of-reason push-back. 4 deterministic checks per new Promise: coupled-reward (regex), conflicts-active (cosine ≥0.85 vs active promises), too-vague (no concrete verb AND no anchor), track-record-doubt (`slip_count ≥ 3`). Returns `{flags, primary, suggestion, details}` or `None`. Templated, no LLM. Surfaces in ack + `[just extracted]` block.
- **`app/services/edge_service.py`** — Generic graph over `edges`. Module-level helpers: `link()` (idempotent on 5-tuple), `unlink()`, `links_for()`, `neighbors(direction='out'|'in'|'any')`, `serialize_edge()`. Callers wire kinds at create time (promise_service wires `utters`/`supports`; list_service.add_item wires `list_item supports focus` on cosine ≥0.75).
- **`app/services/item_service.py`** — Thin facade over `focus_service` + `todo_service`; `/items/*` routes still work, `_serialize_item` polymorphic. `list_items` are arbitrary user-defined lists — focuses/todos/backlog each own a dedicated table.
- **`app/services/list_enrich.py`** — Async venue enrichment for places-shaped lists. `add_item` calls `maybe_enrich_item` after insert; gates on `_looks_places_shaped(name)` regex + empty subtitle. Daemon thread calls Tavily `web_search` → gpt-4o-mini summary → PATCHes subtitle (≤200 char). Re-checks subtitle before commit (manual edit wins). All failures silent. Single attempt, no retries.
- **`app/services/fly_revive.py`** — Boot handshake. `catch_up_orphaned_messages(db)` finds WA convs where last msg is user within 24h + no reply after, sends "fly died, back online" apology, records as assistant Message. Idempotent (apology removes the orphan tail). v1 doesn't re-process orphan through orchestrator.
- **`app/tools/`** — LLM function-calling surface (~25 tools): memory, web, lists, notes, todos (3-state), focuses, habits (fuzzy resolve, refuses unknown), feature_request, activity (`read_recent_commits`, `read_recent_backlog`), calendar (5). Destructive tools (delete/forget/edit-memory/backlog ops) NOT exposed to chat — SMS typos shouldn't wipe data. Dev-only tools stay in `mcp/server.py`.
- **`app/services/trace_builder.py`** — `TraceBuilder` + `PROMPT_VERSION`. Bump version when orchestrator flow / master prompt / memory pipeline change so eval ratings filter cleanly.
- **`app/services/eval_service.py`** — Eval loop. Segments conversations (web = 1 conv = 1 segment; bots sliced by `EVAL_GAP_HOURS`, default 4). `get_segment_full` joins ToolCall audit per message (trace=intended, audit=actual). Dispatches to Claude Code space note + backlog item (idempotent). TipTap-compatible HTML only (no `<details>`).
- **`app/services/focus_synthesizer.py`** — Probe-quality focus surfacer. Gather → embed (cached on `Message.embedding`) → greedy cosine cluster → pairwise merge → sub-cluster → classify (`focus|state|noise`) → state→focus binding (floor 0.38 + 0.10 margin). Pure probe, no DB writes. `_gather_notes` filters `status == 'unprocessed'`. `include_kinds` defaults to `note|todo|fact|message|limbo` — `_gather_limbo` feeds open `LimboItem`s in so recurring batched ideas cluster into FocusCandidates (closes the ambient loop: batch → limbo → synth → candidate → promote).
- **`app/services/focus_candidate_service.py`** — `FocusCandidate` lifecycle. `persist_run` upserts by `cluster_signature`. `promote()` creates Focus, stamps initial+current = centroid, then `_graduate_evidence_notes` walks `evidence_json`, writes `derives_from` edge per note + flips `Note.status='graduated'` (idempotent). State/noise clusters NOT persisted.
- **`app/services/focus_service.py`** — Focus CRUD + hybrid binding (`bind_to_clusters`). Per run: cosine ≥0.70 match (1-to-1, desc sim) → EMA-blend (α=0.7 old, 0.3 new) → refresh evidence + last_seen. Unbound active focuses bump `missed_run_count`; ≥3 → dormant. Drift flagged when `1-cos(initial,current) > 0.35`. `rename` snaps initial := current + clears flag. `fork` flips old to evolved + spawns new w/ lineage.
- **`app/services/batch_service.py`** — the 5am batch processor (ambient-loop engine). `run(db, window_hours=24)`: groups the day's user `Message`s into sessions (>60-min gap), one LLM call per session splits the brain-dump into threads + classifies each (idea|reflection|context|noise|actionable|already_handled), then writes idea/context → `LimboItem` (deduped), reflection → `Memory`. actionable/already_handled were captured real-time → skipped. Also writes ONE session-summary `Note` per session (`note_type='session_summary'`, prose + breakdown, in the 'Sessions' space) — `GET /batch/sessions` lists them for the desktop review. Batched (not real-time) for cross-session context + cost. `_batch_processor_loop` in `background.py` fires it daily 5am (idempotent via `Settings.batch_last_run_day`); `POST /batch/run` triggers manually.
- **`app/services/limbo_service.py`** — `LimboItem` CRUD. `capture` (cosine-dedup at 0.82 → bumps `mention_count` instead of inserting a dup), `promote(item_id, target_type)` (creates focus|todo|promise|memory + `derives_from` edge + flips status), `dismiss` (tombstone — dedup only matches open items so it won't re-bump). Routes: `GET /limbo`, `POST /limbo/{id}/promote {target_type}`, `POST /limbo/{id}/dismiss`. Module-style.
- **`app/services/daily_metric_service.py`** — `DailyMetric` CRUD + cut-table aggregation. `log` (additive insert), `running_total_for_today` (SUM of calories/protein — the number the fitness ack renders), `update_most_recent` (correction flow), `set_cell(day,type,value?,notes?)` (Excel-style cell edit / backfill — COLLAPSES a (date,type) to one row → idempotent override; empty value+notes clears), `cut_table(start,end,fill_gaps=False)` (per-day pivot: cal/protein SUM, weight/alcohol/weed/vape last-value, exercise EXISTS+label, note text; `fill_gaps` emits empty rows for every day in the window — the continuous grid the editable view needs). Module-style like `habit_service`. Routes: `POST /metrics`, `PUT /metrics/cell` (cell edit — numeric types read `value`, exercise/note read `text`; alcohol/weed/vape are BOOLEAN in the UI = value 1 / clear), `GET /metrics`, `GET /metrics/cut-table?days=30&fill=` (→ `{rows, today, updated_at}`), `GET`+`PATCH /metrics/cut-config` (calorie/protein limits + cut start_date, stored on the `Settings` singleton — cols `cut_calorie_limit`/`cut_protein_limit`/`cut_start_date`). `CutTableSection` (StatsView) is the Excel-style grid: editable in dashboard Stats mode (inline cell edit, ● toggle for substances, Cal/Pro header popup sets limit → cell red/green: cal green ≤limit, protein green ≥limit, default 7 rows + show-more, "Day N" counter from start_date). Backfill: `scripts/backfill_cut_table.py` (idempotent, targets `GOONI_URL`). **Chat-routing LIVE** — "i smoked"/"few beers"/"hit the pen" → `extract_signals` emits a `substance` fitness_log → `fitness.handle` → `set_cell(today, alcohol|weed|vape, value=1)` flips the boolean. DailyMetric ONLY (no Habit; sober-streak is a derived read). LLM-detected, not keyword (reads intent — "smoked salmon"/"drank water" don't trigger). Positive-occurrence, boolean. **Backdating:** every fitness log carries an optional `date` the extractor resolves from relative phrasing ("weighed 70.8 yesterday", "smoked tuesday") given today's date injected in the prompt; the handler writes to that day (normalizer clamps future/>1yr → today). No date said → today.
- **`app/services/habit_service.py`** — Habit CRUD + entry upsert + streak / 7-day-strip. Streak forks on polarity: `positive` = consecutive True walking back (one grace day for unlogged today; False/gap breaks); `negative` (avoidance) = days since last True (sober-tracker; counts from creation when no slip). `find_by_name_fuzzy` = case-insensitive substring. True always means "did the literal action" regardless of polarity.
- **`app/services/health_service.py`** — 6-axis composite scoring (memory/chat/engagement/availability/cost/connectors). Each: 0-100 composite + per-component breakdown. Try/except per axis. `PROCESS_START_MONOTONIC` stamped at import for uptime.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound`. Per-channel impls own outbound formatter, allowlist, send client. Returns `(raw, [segments])` — replies split into 1-2 bubbles (≤320 char) via `split_for_bots`. `_MIN_SEGMENT_CHARS=18`, `_MAX_SEGMENTS=2` (safety net; master-prompt does heavy lift). Sentence regex `(?<=[.!?])\s+(?=\S)` so lowercase-casual splits correctly. Web stays unsplit.
- **`app/services/note_service.py`** — Embedding + space suggest + related notes (OpenAI embeddings, cosine).
- **`app/services/take_service.py`** — Daily LLM takes (`GooniTake`, kind=focus|dev). `PROMPT_VERSIONS` per kind; stale rows auto-regenerate. Empty takes not persisted (keeps yesterday alive). **Dev take = JSON** (v3): array of `{theme, summary}`, max 5. FE `parseDevTake` handles legacy v2 prose.
- **`app/services/todo_nudge.py`** — Daily morning digest. Picks ONE thing (priority: promise ≤24h → any active promise → primary todo → most-overdue todo) conversationally. Sweeps `auto_mark_overdue` first. Friend-texting cadence; static one-liner fallback if LLM fails.
- **`app/services/proactive_nudge.py`** — Proactive phase 0. Three deterministic WhatsApp pings: `maybe_fire_procrastination_nudge(db)` (lifespan tick; pings the longest-stalled todo that's sat in `doing` ≥45 min, AT MOST ONCE per todo — gated on `Todo.last_nudge_sent_at IS NULL`, no re-nudge), `maybe_fire_whoop_nudge(row, db)` (queued by `whoop.upsert_today_snapshot` post-commit hook — writes candidate `source_updated_at` to `Settings.whoop_nudge_pending_source_ts` + stamps `whoop_nudge_pending_set_at`; doesn't send inline) and `maybe_fire_sleep_nudge(db)` (lifespan tick; fires when local hour ≥ `Settings.sleep_cutoff_hour` (default 1) AND active signal in last 15 min AND not pinged tonight; idempotent on `last_sleep_nudge_day`). Whoop send via `process_pending_whoop_nudge` — debounced ≥3 min after last `pending_set_at` so webhook bursts collapse to one ping w/ LATEST data. `_proactive_nudge_loop` (background.py) ticks 60s. Channel hardcoded WhatsApp (first `WHATSAPP_ALLOWED_HANDLES`).
- **Greeting fast-path** — bare greetings ("hey", "wsg", "gm") match `Orchestrator._GREETING_RE` at top of `handle_chat`, bypassing extract_signals/router/memory/plan/verify/reflexion. Single gpt-4o-mini call vs PERSONA + last 4 messages. Saves ~$0.03 + ~5s. Compound ("hey gooni whats on my plate") fails regex → full pipeline.
- **Tool-history in recent_history** — `handle_chat` joins `ToolCall` by `message_id` for last 10 assistant messages, inlines `[tools you actually called this turn: ...]` before feeding history to LLM, so Gooni doesn't deny calling a tool it called the prior turn.
- **`app/services/image_storage.py`** — Cloudflare R2 uploader. `POST /uploads/image`. `R2NotConfigured` → 503 → FE falls back to inline base64.
- **`app/llm/client.py`** — OpenAI wrapper. Default chat model `gpt-5.4` (`self.chat_model`); embeddings `text-embedding-3-small`, vision `gpt-4o`. Cheap paths pass `model=` overrides: `gpt-5.4-mini` (extract_signals, batch), `gpt-4o-mini` (reflexion, list-enrich, synth-classify, greeting fast-path). `_execute_with_audit` writes ToolCall rows; failures logged + swallowed (never breaks chat).

### Frontend (`frontend/src/`)

Index of files. Internals grep-able.

- **`ui/`** — Design system (single source of truth). `tokens.ts` (`FONT`, `color` object → `--gooni-*` CSS vars w/ light fallback, plus `scrim`/`radius`/`space`/`fontSize`/`z`), `Button`, `Card`, canonical `Modal`. Barrel `index.ts`. Styling is inline `style={{}}` (no CSS framework; `@emotion` unused). **Don't hardcode `#hex` or redeclare `FONT` — import tokens.** Migration partial (foundation + FONT + two gray families done; most modals + many colors still inline). **`z` is the canonical z-index ladder** (`dropdown 100 < sticky 200 < fab 900 < modalScrim 1000 < modalCard 1010 < panel 1100 < toast 1200`) — every global overlay maps to a rung; don't hardcode a `zIndex` for modals/FABs/dropdowns/toasts. Purely-local in-component stacking is exempt. Theme-store palette (`useGooniThemeStore`) is the ONE place raw hex lives.
- **Themes** — light + dark only. Legacy 5 light variants collapsed → `light`; stored values normalize. Palette pushes `--gooni-*` vars in `routes/__root.tsx`. SettingsModal Appearance tab toggles.
- **`routes/index.tsx`** — Top-level layout. View state: `"notes"|"dashboard"|"chat"|"lists"|"eval"|"stats"`. Top-right icon pair (Globe = public, Plug = MCP).
- **`routes/public.tsx`, `public.index.tsx`, `public.$noteId.tsx`** — Standalone public portfolio (no sidebar/auth).
- **`components/eval/EvalView.tsx`** — Eval tab. Per-source border + badge, filters, segment detail w/ trace cards + ToolCall audit + red-flag popover + dispatch-to-Claude-Code.
- **`components/notes/Sidebar.tsx`, `NotesList.tsx`, `NoteEditor.tsx`** — Sidebar 200px, list 260px, editor (TipTap, auto-save 1.5s, image drag/paste). TipTap extensions: SlashCommand, NoteMention (`@` → note picker), NoteCard (block callout), NoteLink (inline chip → internal nav), LinkCard (URL → OG preview), ToggleBlock, TextColor.
- **`components/ChatView.tsx`** — Full chat. Text streams via SSE (`/messages/stream`); image turns + bots blocking.
- **`components/Dashboard.tsx`** — Single-column. Mode toggle (Today|Review|Ops|Stats, key `gooni-dashboard-v3`, migrates `build`→`ops`, `pulse`→`stats`, `tv`→`today`). Today body reacts to `composerFocused`.
- **`components/dashboard/`** — TodoList (3-state cycle), DashboardHeader, FocusesView (SynthesizerSection + FocusCard grid), FocusCard (normal/drifting/dormant + lineage), SynthesizerSection (candidate pills ✓/✗/↻), FocusDrillDown (modal), HabitsStrip, ReviewMode (ambient-loop triage — navigable session summaries + limbo queue w/ promote→{todo|focus|promise|memory}/dismiss), OpsMode (stacked: BacklogSection + BuildMode + CapabilityProfileCard + FailuresSection), StatsMode (Whoop / CutTable / Streaks / Dev Activity / LeetCode / Usage / Activity), HealthCard, HealthDrillDown.
- **`components/StatsView.tsx`** — Section module. Exports `WhoopSection`, `LeetcodeSection`, `DevSection`, `ActivitySection`, `SectionShell`, `BigStat`, `relTime`, `fmtInt` for `StatsMode`. Top-level `StatsView` no longer routed.
- **`components/SettingsModal.tsx`** — Tabbed: Appearance (theme+face), Notifications, Integrations (Calendar/GitHub/Whoop), Deployments (Fly+Vercel health).
- **`components/FocusOverlay.tsx`, `QuickNav.tsx` (Cmd+K), `QuickComposer.tsx` (Cmd+E), `GooniPanel.tsx`** — overlays + capture. QuickComposer dispatches `gooni:note-created` so Dashboard re-pulls.
- **`utils/focusColors.ts`** — Mirrors backend `_COLOR_PALETTE`. `resolveFocusColor(color, id)` falls back to id-derived index for null legacy rows.
- **`stores/`** — Zustand. Keys: `gooni-notes-v1`, `gooni-v4`; theme store syncs CSS custom props via `routes/__root.tsx`.
- **`services/api.ts`** — All fetch calls. Interfaces: `ApiNote`, `ApiSpace`, `PublicNote`, `PublicNoteDetail`.

### MCP Server (`mcp/server.py`)

Exposes Gooni to Claude Code via stdio.

**Memory**: `get_context`, `add_memory`, `search_memories`, `edit_memory`, `forget_memory`
**Notes**: `add_note` (defaults "Claude Code" space, `is_draft`/`is_pinned`), `search_notes`, `edit_note` (tri-state flags: None=unchanged), `find_note`, `read_note`, `delete_note`, `list_notes`
**Comments**: `add_comment` (author defaults "claude"), `list_comments`
**Capability**: `read_capability_facets(layer?)`, `update_capability_facet(facet_key, facet_text?, status?, layer?)`
**Stats**: `get_leetcode_activity`
**Spaces**: `list_spaces`
**Lists** (todo + user-defined; `list_ref="backlog"` REJECTED — use backlog APIs): `read_list`, `add_list_item` (cosine-dedup), `find_similar_items`, `check_list_item`, `delete_list_item`
**Backlog tickets** (own table): `read_backlog`, `add_backlog_item` (conflict scan), `find_similar_backlog`, `set_backlog_state`, `complete_backlog_item` (pr_url closes), `delete_backlog_item`, `promote_backlog_to_primary`, `clear_primary_backlog`

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
cd frontend && npm run lint              # eslint — react-hooks/rules-of-hooks is error (gates CI); rest are warn
source venv/bin/activate && python -c "from app.main import app; print('OK')"
```

ESLint is flat-config (`frontend/eslint.config.js`): full `@eslint/js` + `typescript-eslint` + `react-hooks` recommended. Only `rules-of-hooks` is a hard **error** (the CI gate, via `.github/workflows/frontend-lint.yml`); pre-existing recommended violations are **warn** and burn down incrementally. Don't add new errors; clear warnings in files you touch when cheap.

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

`alembic upgrade head` runs on uvicorn boot via `_alembic_upgrade()` in `app/main.py`. No `Base.metadata.create_all` at runtime; alembic alone owns schema. Fresh DBs walk from baseline (`ebbf04b84ba5`) to head on first boot.

**Half-applied-state recovery:** `_alembic_upgrade` catches `OperationalError: ... already exists / duplicate column`, stamps cursor to head, continues boot. SQLite auto-commits DDL the moment a `CREATE TABLE` runs, so if the process dies before the version-stamp UPDATE lands, the next boot re-runs the migration and would crash on the existing table. Other `OperationalError` shapes (bad column type, missing FK) still propagate.

**Migration-author convention:** for `CREATE TABLE` / `ADD COLUMN`, prefer inspector guards so re-runs are no-ops:
```python
def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table('foo'):
        op.create_table('foo', ...)
```

## Daily digest

`app/services/todo_nudge.py::compose_message(db)`. Daniel writes prompt in `Settings.nudge_prompt`; service injects today's overdue + due-today todos + active focuses after his prompt before LLM call. Empty falls back to `DEFAULT_PROMPT`.

Scheduler in FastAPI **lifespan** (not bot script) so config + idempotency are DB-backed and survive bot restarts. Zoneinfo-aware via `Settings.nudge_tz`. `Settings.nudge_last_sent_day` kills double-send if Fly scales to 2. WhatsApp respects Meta's 24h customer-window: no inbound WA in 24h → skip WA channel. Telegram unconstrained.

## Code Patterns

- **Zustand persist**: bump key on shape change (`v1` → `v2`) to avoid stale state
- **Singleton services**: each `app/services/*.py` creates one instance at the bottom
- **FastAPI `db: Session = Depends(get_db)`** — session per request, auto-closed
- **Optimistic UI**: `createNote` adds temp note, replaces w/ API response
- **React StrictMode**: kept intentionally; double-fires effects in dev to expose bugs
- **hasChanges ref**: NoteEditor only `save()`s if user actually typed — prevents `updated_at` touch on blur
- **Public routes** `/public` + `/public/$noteId` are standalone (no sidebar/auth)
- **Images in notes**: base64 inline via TipTap Image extension; large uploads go through `/uploads/image` → R2 URL
- **Deferred embedding columns**: `Note.embedding`, `Note.classified_embedding`, `ListItem.embedding`, `Memory.embedding`, `Message.embedding` wrapped in `deferred()`. List/read endpoints skip the ~31KB-per-row hit. Similarity callers MUST use tuple queries (`db.query(Note.id, Note.embedding).all()`) not `.query(Note).all()` to avoid N+1 lazy-load storm.
