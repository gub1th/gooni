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
- **`app/db/models.py`** — SQLAlchemy models: `Space`, `Note` (carries `is_pinned` + `is_public_pinned` (separate hero pin for the /public landing page) + `is_draft` + `is_public` + `excerpt` (cached plain-text preview, stripped of HTML/`<img>`, capped at 240 chars — populated on every save, lazy-backfilled at startup so list endpoints don't ship full bodies)), `Conversation`, `Message`, `Memory`, `List`, `ListItem` (generic list rows only — text/subtitle/done/sort_order; focus / todo / backlog fields all moved to dedicated tables in the focus/todo/backlog extraction), `Focus` (long-running commitments — endgoal/health/confidence/scale/status/start_at/end_at/committed/`color`; auto-assigned 10-color palette dot for the dashboard. **Post-revamp:** `is_primary` moved to Todo; the M2M `focus_todo_links` table is gone — todos link via single FK. **Drift cols** (focus-drift PR): deferred `initial_signature` (centroid at promotion, frozen) + deferred `current_signature` (EMA-updated per bind), `current_evidence_json` snapshot, `last_seen_in_synth`, `missed_run_count` (≥3 → status='dormant'), `drift_flagged_at` (one-shot when `1-cos(initial,current) > 0.35`), `promoted_from_candidate_id` FK, `evolved_from_focus_id` FK (lineage chain via `/focuses/{id}/fork`). `status` vocab gains `'dormant'` + `'evolved'`), `Todo` (actionable item; carries `state` enum ('not_yet' | 'doing' | 'done' — synced w/ legacy `done` bool), `focus_id` single-FK to its parent focus, `is_primary` singleton (only one Todo across the table can be True; auto-cleared on completion)), `BacklogTicket` (engineering backlog ticket with board_status + pr_url + `notes` (free-form multi-line body — context/design notes/follow-up scratch; subtitle stays as the one-line tagline) + `todo_id` (FK set when promoted into a Todo via `/backlog/tickets/{id}/promote`); `board_status` vocab is `'not_yet' | 'doing' | 'done'` post-revamp (was `'todo' | 'in_progress' | 'done'` — migrated)), `PublicProfile` (carries `bio` + `avatar_url` — uploaded avatar URL via R2; NULL falls back to a deterministic goofy-emoji avatar in NoteComments), `Visit`, `OAuthToken`, `TrackedRepo`, `McpCall` (append-only log of MCP-tagged HTTP requests; powers the dashboard "claude activity" stat), `ClaudeUsageTurn` (one row per Claude Code assistant turn, ingested by `scripts/upload_claude_usage.py`; UNIQUE on `session_id, ts`), `EvalSegment`, `EvalStepFeedback`, `EvalMessageRating` (per-assistant-message thumbs — 1=bad/2=meh/3=good with optional comment, UNIQUE on `message_id`; complements step-level feedback + segment overall rating), `WhoopSnapshot` (one row per day; cached recovery/HRV/RHR/strain/sleep pull served by `/whoop/today`), `LeetcodeSnapshot` (one row per UTC date; cached pull from leetcode.com/graphql — streak/today_count/week_count + raw 365d submission calendar; served by `/leetcode/today`, lazy-fetched via `leetcode_service.get_or_fetch`), `GooniTake` (daily LLM-generated takes — kind="focus" one-sentence on what Daniel's focused on, kind="dev" short paragraph on what Daniel shipped today; UNIQUE on (`day`, `kind`); upserted by `take_service.get_or_generate`), `NoteComment` (Confluence-style flat comment thread under each note; CASCADE-deletes with the note; `author` is a free-text label like "daniel"/"gooni"/"claude"), `ToolCall` (audit row per chat-tool invocation; lifecycle `running → done|failed`; columns: conversation_id, message_id (nullable, backfilled by orchestrator after assistant Message exists), tool_name, args_json, status, result_json, error, started_at, finished_at. Substrate for the anti-hallucination layer + future ReAct loops — "I added X" only holds water if a matching `tool_calls` row exists with status=done. Writes happen in `app/llm/client.py::_execute_with_audit`; auditing must never break the chat path so insert/update failures are logged and swallowed.), `FocusCandidate` (proposed focus surfaced by the synthesizer; lifecycle `proposed → promoted|dismissed`; columns include name/endgoal/category/confidence/reasoning, `cluster_signature` (sha256 of sorted "{kind}#{id}" items — deterministic upsert key so re-emit bumps seen_count instead of duplicating), evidence_json, deferred `centroid_embedding`, `parent_candidate_id` (sub-cluster → parent link), `promoted_focus_id` + `promoted_at`, `dismissed_at`, `first_seen_in_synth` + `last_seen_in_synth` + `seen_count`. Persisted via `POST /focus-candidates/run`; status flips via `/promote` (creates Focus row) and `/dismiss`. Status sticky on re-emit — only confidence/name/evidence snapshot refresh + seen_count bumps. State / noise clusters intentionally NOT persisted; state attaches as bound evidence under its parent focus only.), `Habit` (daily binary tracker — name/color/polarity ('positive' | 'negative' — affects connotation only, never inverts value semantics) /sort_order/archived_at), `HabitEntry` (one row per (habit, date) — value Bool, UNIQUE(habit_id, date); absence of row = unknown/unlogged. Cascades on habit delete. Streak = consecutive value=True days walking back from today, with one grace day if today is unlogged), `WaProcessedId` (idempotency log for inbound WhatsApp messages — `wamid` PK + `created_at` index. The `/webhooks/whatsapp` handler claims a wamid before queueing the background orchestrator task; a Meta retry that races in parallel hits the UNIQUE constraint and short-circuits instead of double-firing the chat turn), `Reflection` (Reflexion-pattern self-evaluation row written async after every assistant turn — message_id CASCADE FK + conversation_id FK; carries `user_critique_present`, `critique_summary`, `action_vs_described` ('acted'|'described'|'mixed'|'na'), `gap_exposed`, deferred `gap_embedding`, `proposed_self_fix`, severity 1-3, `model`. ALL severities persist (even sev 1 'clean turns') so the reflexion classifier itself stays eval-able. Severity ≥ 2 + gap_exposed triggers cosine clustering against the last 30d of reflections — 3+ matches above 0.8 auto-promotes a behavioral CapabilityFacet via `capability_service.promote_behavioral_facet`. Written by `reflexion_service.reflect()` in a daemon thread with its own SessionLocal — never blocks the chat reply path; failures are logged + swallowed), `CapabilityFacet` (Gooni's self-knowledge inventory — UNIQUE on `facet_key` so all 4 audit sources upsert the same row. Layers: `mechanical` (tools/routes/channels — auto-populated by boot-scan from `app/tools/registry` + `app.routes` + `messaging/`), `functional` (composed "what I can do" — pr_audit + manual_seed), `behavioral` (emergent patterns — auto-promoted from reflection clustering), `architectural` (model/runtime/memory shape — manual_seed). Status: `claimed | verified | unverified | broken | removed` — flipped by runtime telemetry (≥1 successful ToolCall in 30d → verified; 0 → unverified; ≥3 failures in 7d → broken) and by chat/PR edits. Never deleted at runtime; a removed tool flips to status='removed' so history survives. Injected into the master prompt as a "Who I am right now" block via `memory_service.build_memory_context_with_debug` so Gooni grounds 'I can / I can't' answers in verified self-knowledge instead of hallucinating).
- **`app/db/database.py`** — SQLite via `SessionLocal`, `get_db`
- **`app/services/memory_service.py`** — Local SQL-backed memory store (the `memories` table). Per chat exchange: `extract_candidates` (LLM) → cosine-search similar active memories → `reconcile_candidate` (LLM, ADD/UPDATE/DELETE/NONE) → apply. Retrieval injects always-included preferences plus top-5 facts/episodes by cosine similarity. `build_memory_context_with_debug` also prepends the capability profile via `capability_service.build_prompt_block` so the master prompt opens with "Who I am right now" before Daniel's preferences. Replaced the old Mem0 hosted service; legacy callers still see `{id, memory, ...}` dict shape via `_serialize`.
- **`app/services/reflexion_service.py`** — Per-turn self-evaluation (Reflexion pattern, Shinn et al.). After every assistant Message lands, `reflect_async` spawns a daemon thread with its own SessionLocal. The thread pulls last 3 reflections + this message's ToolCall audit, calls gpt-4o-mini (JSON-mode), and persists a `Reflection` row. Severity ≥ 2 + gap_exposed → embed gap_text + cosine-cluster against last 30d of reflections; ≥3 matches above 0.8 auto-promotes a behavioral `CapabilityFacet`. Cost ~$0.0001/turn. Hook lives in `orchestrator.py` after both the normal-reply assistant_msg AND the short-circuit feedback_ack — the short-circuit path is the highest-leverage spot because that's where "logged, didn't act" failure mode happens.
- **`app/services/capability_service.py`** — Owner of `capability_facets`. `refresh_mechanical_layer` runs at FastAPI lifespan start: walks tool registry + `app.routes` + messaging channels + source-hash short-circuits. Tools/routes that vanish flip to status='removed' rather than deletion. `promote_behavioral_facet` is called from reflexion clustering with a centroid hash-derived facet_key (idempotent re-firing). `run_telemetry_rollup` runs once daily at 03:00 via `_capability_telemetry_loop()` in main.py — counts ToolCall rows per tool, flips status verified/unverified/broken accordingly. `build_prompt_block` formats the user-facing layers (functional/behavioral/architectural — mechanical is implicit in the LLM's function schemas) into a "Who I am right now" bullet block capped at 30 lines, injected into the master prompt.
- **`app/services/orchestrator.py`** — Unified chat handler across all surfaces (web, telegram, whatsapp, imessage). `Orchestrator` singleton. Source defaults to `"web"`; bot channels share a single persistent conversation per source (no gap-based sessioning). Each turn builds a structured trace via `TraceBuilder` and stamps it on `Message.trace`.
- **`app/tools/`** — chat tool surface exposed to the LLM via OpenAI function-calling. Registry in `app/tools/__init__.py` (~23 tools): memory (save_memory), web (web_search, fetch_url), lists (add_to_list, show_list, check_list_item), notes (search_notes, add_note, find_note, read_note, list_recent_notes), todos (add_todo, list_todos, set_todo_state — 3-state: not_yet|doing|done), focuses (add_focus, list_focuses), habits (log_habit — fuzzy resolves habit name by case-insensitive substring; refuses unknown habits so the LLM can't surprise-create), feature_request, calendar (5). Destructive tools (delete/forget/edit-memory/backlog ops) are deliberately NOT exposed to chat — chat surface is non-destructive by design so SMS typos can't wipe data. Dev-only / Claude-Code-only tools live in `mcp/server.py` and stay there.
- **`app/services/trace_builder.py`** — `TraceBuilder` helper + `PROMPT_VERSION` constant. Single source of truth for the per-turn trace shape: `{key, label, input, output, meta}` per step plus a leading `pipeline_version` step. Bump `PROMPT_VERSION` when you change orchestrator flow / master prompt assembly / memory pipeline so eval ratings can be filtered by pipeline iteration. Backward-compat aliases (`type`, `detail`, `args`) keep the existing chat MessageBubble rendering until it migrates.
- **`app/services/eval_service.py`** — Eval loop for chat replies. Segments conversations (web = 1 conv = 1 segment; bot threads sliced by `EVAL_GAP_HOURS`, default 4). CRUD for `EvalSegment`, `EvalStepFeedback`, and `EvalMessageRating` (per-message thumbs). `get_segment_full` joins `ToolCall` audit rows per message (status / args / result / error / duration) and ships them alongside the trace JSON — the trace says what the orchestrator *intended* to run; the audit shows what *actually* executed. Dispatches finished evals to a Claude Code space note + a backlog list item (idempotent on re-dispatch — overwrites the prior note rather than spawning duplicates). Dispatch body uses TipTap-compatible HTML (no `<details>`/`<summary>` — those are silently dropped by StarterKit and were the cause of dispatched notes rendering empty) and stamps `excerpt` on the note alongside `content` so list-view previews populate immediately. Static `TOOL_LEGEND` seeds the ⓘ legend popup in the eval UI.
- **`app/services/feedback_detector.py`** — Natural-language feedback detector (regex pre-filter + gpt-4o-mini classifier). Used by the orchestrator + eval surfaces to identify follow-up messages that critique a prior assistant reply.
- **`app/services/focus_synthesizer.py`** — Probe-quality focus surfacer. Gathers notes / todos / deduped fact memories / recent user chat messages, embeds (uses cached `Message.embedding` on hit, persists on miss), greedy-clusters by cosine, runs a pairwise centroid merge pass, sub-clusters parents above MIN_PARENT_FOR_SUBCLUSTER at a tighter threshold, then parallel-classifies each cluster as `focus | state | noise` via gpt-4o-mini. Post-classify: state→focus binding pass (compound test = absolute floor 0.38 + ≥0.10 margin over runner-up) attaches state clusters to their nearest focus as `bound_state` evidence — intent statements and activity logs about the same focus split at the embedding level due to language shape, so we re-unite at presentation time. Returns candidates JSON; no DB writes. Pure probe surface lives at `POST /focus-synthesis/run`.
- **`app/services/focus_candidate_service.py`** — Persistence + lifecycle for `FocusCandidate` rows. `persist_run(db, synth_output)` upserts focus-shaped clusters (top-level + sub-cluster focuses) by `cluster_signature`. Re-sight bumps seen_count + refreshes the LLM-classified name/endgoal/reasoning + evidence snapshot; status stays sticky once a candidate is promoted or dismissed. `promote()` creates a real `Focus` row via `focus_service.create`, stamps `initial_signature` = `current_signature` = candidate centroid + `current_evidence_json` + `promoted_from_candidate_id`, then sets candidate `status='promoted'`. `dismiss()` flips status + stamps timestamp. State / noise clusters intentionally not persisted.
- **`app/services/focus_service.py`** — Focus CRUD plus the hybrid binding pass (`bind_to_clusters`). The binding pass is the runtime of the "stable handle, drifting evidence" design: each synth run, every focus-shaped cluster greedily matches against an active Focus's `current_signature` (cosine ≥ 0.70, 1-to-1 assignment by descending sim). Match → EMA-blend signature (α=0.7 on old, 0.3 on new cluster centroid), refresh evidence + `last_seen_in_synth`, reset `missed_run_count`. Active focuses unbound this run bump `missed_run_count`; ≥3 → `status='dormant'`. Bound focuses with `1 - cos(initial, current) > 0.35` AND no prior flag → stamp `drift_flagged_at`. `rename(focus_id, text?, endgoal?)` snaps initial_signature := current_signature + clears drift flag. `fork(focus_id, new_text)` flips old to status='evolved' + spawns a new Focus inheriting the drifted signature + links lineage via `evolved_from_focus_id`. Focuses with `status='dormant'` or `'evolved'` are excluded from the active filter so they don't accumulate misses or compete for binds.
- **`app/services/habit_service.py`** — Habit CRUD + entry upsert + streak / 7-day-strip computation. Streak walks backward from today (or yesterday if today is unlogged — one grace day so the streak doesn't visually reset the second midnight ticks), counting consecutive value=True days; an explicit False or a missing day breaks. `recent_strip(habit_id, days=7)` returns oldest→newest cells, `value` tri-state (True / False / None). `find_by_name_fuzzy` is case-insensitive substring match — the chat-tool path uses it to resolve "gym" → "went to gym". Habit names are always phrased positively; `polarity` flag is metadata, never inverts value semantics.
- **`app/services/health_service.py`** — Gooni-health composite scoring across 6 axes (memory / chat / engagement / availability / cost / connectors). Each axis: 0-100 composite + per-component {score, weight, detail} list + headline string. Composite is a weighted average of normalized components. Scores are gameable gut-checks, not formal SLAs — the component breakdown is the actual signal. `PROCESS_START_MONOTONIC` stamped at import time so the availability axis can report uptime without a separate cron. `compute_all(db)` is the single entrypoint behind `GET /health/scores`; each axis is wrapped in try/except so one explosion doesn't take down the dashboard.
- **`app/services/messaging/`** — `MessagingChannel` ABC + `dispatch_inbound` pipeline. Per-channel impls: `telegram.py`, `whatsapp.py`, `imessage.py`. Each owns its outbound formatter (markdown → channel-native), allowlist, and send client. Webhook routes in `app/main.py` call `dispatch_inbound(channel, sender, text, db)` → orchestrator → channel-specific reply. `dispatch_inbound` returns `(raw_text, [formatted_segments])`: bot replies are split into 1–4 short bubbles via `split_for_bots` (paragraph-aware, sentence-aware for long paras, ≤4 bubbles, ≤320 chars each) so WA/Telegram/iMessage feel like texting instead of one wall of text. Web chat doesn't use `dispatch_inbound` and stays unsplit. Callers iterate segments with a short delay between sends; Telegram also fires `chat.send_action(typing)` between bubbles.
- **`app/services/note_service.py`** — Embedding + space suggestion + related notes (OpenAI embeddings, cosine similarity).
- **`app/services/take_service.py`** — Daily LLM-generated takes. `get_or_generate(db, kind, force=False)` upserts a `GooniTake` row keyed on (today, kind). kind="focus" reads recent notes + active focuses; kind="dev" reads commits/PR titles across tracked repos (last 24h). Empty takes aren't persisted — keeps yesterday's row alive when today's source is empty (no commits, no notes). `PROMPT_VERSION` constant — bump when prompt/input shape changes so history rows from different eras can be filtered apart.
- **`app/services/image_storage.py`** — Cloudflare R2 (S3-compatible) image uploader. Used by `POST /uploads/image` for pasted/dropped images so notes carry URLs instead of multi-MB base64 data: URLs (PR #134 OOM postmortem). Returns `R2NotConfigured` when env is missing — route translates to 503 and the frontend falls back to inline base64.
- **`app/llm/client.py`** — OpenAI wrapper (`llm_client`). Default model: `gpt-4o-mini`.

### Frontend (`frontend/src/`)
- **`routes/index.tsx`** — Layout: Sidebar | NotesList | NoteEditor | GooniPanel (optional). View state: `"notes" | "dashboard" | "chat" | "lists" | "eval" | "stats"`. Top-right pair of icon buttons (Globe = public profile, Plug = MCP) lives here, fixed-position, visible on every view.
- **`components/eval/EvalView.tsx`** — Eval tab. Grid of conversation segments (Google Docs-style cards) w/ per-source border + badge (web/telegram/whatsapp/imessage), filters (source, status, has-flag, search), and detail view per segment. Detail view: transcript + per-message trace cards (intent / memory_recall / master_prompt / extracted_signals / memories_applied / tool_call / reply), red-flag popover per step (1/2/3 + comment), per-message **Tool Calls** section rendering the `ToolCall` audit rows (status pill / tool_name / duration / error; expandable args+result) — surfaces hallucinations and mid-flight failures the trace can't show, overall summary editor, ⓘ tool-legend popup, and a "Dispatch to Claude Code" button that bundles the eval into a `Claude Code` space note plus a backlog list item.
- **`routes/public.tsx`** — Layout shell for `/public/*` (just renders `<Outlet />`).
- **`routes/public.index.tsx`** — Public portfolio list: Posts tab (space-filtered) + About tab (bio).
- **`routes/public.$noteId.tsx`** — Full public note detail page.
- **`components/notes/Sidebar.tsx`** — 200px. Two draggable sections (Notes / Chat), order persisted in localStorage. Notes section has: All Notes, collapsible Spaces list, recent notes. Chat section has: New Chat + recent conversations.
- **`components/notes/NotesList.tsx`** — Notes for selected space (260px).
- **`components/notes/NoteEditor.tsx`** — Title + TipTap body. Auto-saves after 1.5s. `🌐 Public` toggle pill. Supports image drag/drop + paste (base64 inline). `hasChanges` ref prevents spurious saves on blur.
- **`components/ChatView.tsx`** — Full chat view when chat section is active. Uses `chat/InputBar` (Gemini-style: + popup → upload image, model selector, mic for Web-Speech-API voice-to-text, send). Image attachments flow as base64 data URL via `image_url` to `/conversations/{id}/messages`. Text-only turns stream through `POST /conversations/{id}/messages/stream` — `StreamingProgress` renders the live pipeline stage label + in-flight tool cards (running ◯ → done ✓ / failed ✗) while the model works. Image turns and bot channels stay on the blocking endpoint.
- **`components/Dashboard.tsx`** — Single-column dashboard with a top-tier mode toggle. Layout top→bottom: `DashboardHeader` → `ModeToggle` (Today | Build | Pulse, segmented pill + per-mode bg-color picker; persists under `useDashboardStore` key `gooni-dashboard-v2`). Mode-specific body content: **Today** = TakeTabs → NoteEditor quick-input → inner `TabToggle` (Todos | Focuses) → TodoList or FocusesView → HabitsStrip (the prior dashboard). **Build** = `BuildMode` (Gooni-health 6-axis composite scores). **Pulse** = `PulseMode` (life-stats grid).
- **`components/dashboard/TodoList.tsx`** — Pulls `/todos` (primary + open + done_today buckets). 3-state cycle: empty square → dotted half (doing) → filled check (done); from done, click pops a state-picker. Focus color dot per row (resolves via `utils/focusColors.ts`). Hover row exposes promote-to-primary (crown) + delete (×).
- **`components/dashboard/FocusCardsRow.tsx`** — Pulls `/focuses`. Horizontal scrollable row, card per active focus w/ color left-rail + dot, X/Y progress bar of linked todos sourced from `_focus_tree_node`.
- **`components/dashboard/WhoopStrip.tsx`** — legacy 3-card strip. No longer mounted on the dashboard (header consolidates the stats inline). Kept around in case Stats view wants the bigger surface back; nothing else references it today.
- **`components/dashboard/DashboardHeader.tsx`** — greeting + date on the left, NeuralBrain + inline Whoop stats (recovery/sleep/strain, only when connected) + day-streak counter on the right.
- **`components/dashboard/TabToggle.tsx`** — segmented pill (`Todos | Focuses`). Active tab state lives in `useDashboardStore`, persisted under `gooni-dashboard-v1`.
- **`components/dashboard/FocusesView.tsx`** — focuses tab body. `SynthesizerSection` card on top (proposed candidate pills + ✓ promote / ✗ dismiss + ↻ run-synth trigger). 3-col grid of `FocusCard` below. `+ manual` demoted to the section header. Drill-down modal mounted as a sibling, opened by focus card click.
- **`components/dashboard/FocusCard.tsx`** — single card. Three visual states: normal (color dot + name + signals count + progress bar), drifting (amber dot in corner + "drifting" subtitle — click opens Rename/Fork popover), dormant (50% opacity + "dormant" underline — click opens Reactivate/Archive popover). Lineage breadcrumb ("↑ evolved from X") when `evolved_from_focus_id` is set.
- **`components/dashboard/SynthesizerSection.tsx`** — proposed candidate pills. High-conf (≥0.70) surface first; low-conf collapse into `+ N more` expander. Each pill has inline ✓/✗ buttons wired to `/focus-candidates/{id}/promote` and `/dismiss`. ↻ icon triggers `/focus-candidates/run` synchronously w/ spinner.
- **`components/dashboard/FocusDrillDown.tsx`** — modal opened by focus card click. Header (name + endgoal + drift/dormant badge + lineage line), two-column body (linked todos on the left from `/items/{focus_id}/todos`, bound state evidence from `current_evidence_json` on the right). Action bar: Rename / Fork / Reactivate (when dormant) / Delete. Closes on Esc or click-outside.
- **`components/dashboard/HabitsStrip.tsx`** — Bottom-of-dashboard daily binary tracker. Row per habit: color dot + name + 7 cells (oldest → newest, today rightmost w/ ring) + 🔥 streak counter + hover delete. Click any cell to cycle empty → ✓ → ✗ → empty. Inline `+ add habit` create. Pulls `/habits` (each row includes `recent: ApiHabitCell[]` + `streak: number`). Habits are always phrased positively; `polarity` flag stays in the model for downstream colour decisions but doesn't invert value semantics.
- **`components/dashboard/ModeToggle.tsx`** — top-tier dashboard mode toggle (Today | Build | Pulse). Per-mode background tint customizable via the palette button next to the pill — choice persists per-mode in `useDashboardStore.modeColors`. Active mode also persisted under `gooni-dashboard-v2`.
- **`components/dashboard/BuildMode.tsx`** — "Gooni Health" surface. 2-col grid of `HealthCard`s, one per axis (memory / chat / engagement / availability / cost / connectors). Each card click opens `HealthDrillDown` modal w/ per-component breakdown bars. Pulls `/health/scores`; scores recomputed on every mount (60s staleTime).
- **`components/dashboard/PulseMode.tsx`** — life-stats grid w/ consistent stat-card chrome (small label + big number + sub). Cards: recovery / sleep / strain (Whoop) · LeetCode streak / today · habit streak · day streak · commits today / commit streak · claude turns. Whoop cards dimmed when not connected.
- **`components/dashboard/HealthCard.tsx`** — single health-axis card. SVG ring (red <40 / amber 40-70 / green >70) wraps the composite score; label + headline beside it. Click → drill-down.
- **`components/dashboard/HealthDrillDown.tsx`** — modal w/ per-component bars. Each component: name + weight + score + horizontal progress bar + detail line. Esc + click-outside close.
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
- `read_capability_facets(layer?)` — read Gooni's capability inventory (group-by-layer Markdown). Used by the `/capability-audit` Claude Code skill to inspect what's on record before proposing edits.
- `update_capability_facet(facet_key, facet_text?, status?, layer?)` — idempotent create/update on a capability facet. Layer required only when creating. Companion to the chat-surface tool `update_capability_facet` (same name, exposed to the chat LLM via `app/tools/update_capability_tool.py`) so both Claude Code AND the orchestrator-side LLM can revise self-knowledge.
- `list_spaces()` — list all spaces
- `list_notes(space_id, limit)` — browse notes in a space
- `read_list(list_ref="todo", limit, include_done)` — read items from a list (todo / focus singletons + user-defined lists). Resolves by type → name → numeric id. **`list_ref="backlog"` is REJECTED** — backlog tickets live in their own table; use `read_backlog` instead.
- `add_list_item(text, list_ref="todo", subtitle?, skip_conflict_check=False)` — add to a list_items list. Cosine-checks against existing items; near-duplicates surface as `conflicts: [{id, text, similarity, severity}]`. **`list_ref="backlog"` is REJECTED** — use `add_backlog_item`.
- `find_similar_items(text, list_ref="todo", threshold=0.78, limit=5)` — read-only similarity search over a list_items list. **`list_ref="backlog"` is REJECTED** — use `find_similar_backlog`.
- `check_list_item(match, list_ref="todo", done=True)` — toggle done by text match (first-hit-wins). **`list_ref="backlog"` is REJECTED** — use `complete_backlog_item`.
- `delete_list_item(match, list_ref="todo")` — delete by text match; refuses ambiguous matches. **`list_ref="backlog"` is REJECTED** — use `delete_backlog_item`.

**Backlog tickets** (own `backlog_tickets` table — separate from list_items since the focus/todo/backlog extraction):
- `read_backlog(limit, include_done)` — list tickets w/ board_status + pr_url
- `add_backlog_item(text, subtitle?, notes?, skip_conflict_check=False)` — create; conflict scan via the new `POST /backlog/tickets/similar` route. Same `conflicts` response shape as `add_list_item`. `notes` is the multi-line body (design notes / context).
- `find_similar_backlog(text, threshold=0.78, limit=5)` — read-only cosine search across the board.
- `complete_backlog_item(match, pr_url?, notes?)` — mark a ticket done by text match. `pr_url` closes the lifecycle loop (sets `pr_url` + `board_status='done'`); `notes` lets you append context/decision-log at close time.
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
PATCH /notes/{id}               → update note { title?, content?, space_id?, is_public?, is_pinned?, is_public_pinned?, is_draft? }
DELETE /notes/{id}              → delete note
POST /notes/{id}/embed          → generate embedding + suggest space
POST /notes/{id}/touch          → update last_opened_at
POST /notes/{id}/memorize       → extract facts → memory store

GET  /notes/{id}/comments       → list comments on a note (oldest first)
POST /notes/{id}/comments       → append comment { content, author? }
DELETE /comments/{id}           → delete a comment by id

POST /uploads/image             → multipart image upload → Cloudflare R2; returns { url, key }. Used by NoteEditor paste/drop. Returns 503 when R2 env unset → frontend falls back to inline base64 (legacy path). 10 MB per upload, image/* content-types only.

GET  /public/notes              → public notes list { id, title, space_name, excerpt, updated_at, is_public_pinned }. Ordered public-pinned first, then newest.
GET  /public/notes/{id}         → full public note (404 if not public)
GET  /public/profile            → { bio, avatar_url, note_count, last_active }
PATCH /public/profile           → partial save { bio?, avatar_url? }. `avatar_url: null` clears back to the goofy-emoji default. Avatar uploads go through POST /uploads/image first to get the R2 URL.

POST /chat                      → Gooni chat { content, entry_content?, model? }
GET  /feed                      → all conversations
GET  /conversations/{id}/messages
POST /conversations/{id}/messages → send message + get reply (blocking)
POST /conversations/{id}/messages/stream → SSE variant. Same payload, streams pipeline events (`stage`, `tool_start`, `tool_done`, `done`, `error`) so web chat can render live progress + in-flight tool cards. Worker runs `Orchestrator.handle_chat` in a background thread with its own `SessionLocal`; event_cb pushes to a Queue that the SSE generator drains. Bot channels do NOT use this — they stay on the blocking endpoint. Image path also stays blocking (vision orchestrator emits no stage events). Heartbeat every 15s keeps Fly's edge proxy from idle-killing long replies.

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
POST /webhooks/whatsapp         → Meta Cloud API webhook (HMAC-verified). Dedups on `messages[i].id` via `wa_processed_ids` (UNIQUE PK) — Meta retries any delivery we don't 200-ack within ~20s and a chat turn often blows past that. The HTTP handler claims the wamid then queues the orchestrator + reply send via `BackgroundTasks`, so we ack fast and the orchestrator runs after. A retry that races a parallel arrival hits IntegrityError and short-circuits.

GET  /capabilities              → grouped-by-layer list of capability facets (mechanical/functional/behavioral/architectural). Skips `_meta` (internal scan-hash sentinel). Status='removed' rows ARE returned so the FE can render them dimmed.
POST /capabilities              → manual create. Body `{facet_key, layer, facet_text, status?, source?}`. 409 on duplicate facet_key.
PATCH /capabilities/{id}        → hand-edit. Allowed fields: `facet_text`, `status` (claimed|verified|unverified|broken|removed), `layer`. Source auto-flips to 'chat_tool_update' to mark provenance.
POST /capabilities/telemetry/refresh → manual fire of the daily ToolCall-audit rollup the lifespan loop runs at 03:00 local. Updates `last_verified_at` + status transitions.
POST /capabilities/boot-scan/refresh → manual fire of the boot-time mechanical-layer scan. Use after adding a tool/route mid-session without restarting uvicorn.

GET  /reflections?conversation_id=N&message_id=M&severity_min=1&limit=50 → list Reflection rows (per-turn self-evaluations). Defaults to most-recent 50 across the whole DB.
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

# Focus synthesizer + candidate audit:
POST /focus-synthesis/run       → pure probe (no DB writes). Runs the clustering+classify pipeline and returns the candidate JSON for eyeballing. Body knobs: include_kinds, threshold, merge_threshold, sub_threshold, min_parent_for_subcluster, min_sub_size, min_cluster_size, classify, classify_model, state_bind_sim (default 0.38), state_bind_margin (default 0.10).
POST /focus-candidates/run      → runs synth → **binds clusters to existing Focuses** (`focus_service.bind_to_clusters`) → persists the unbound focus-shaped clusters as candidates. Binding pass updates the Focus's `current_signature` (EMA-blend with the cluster centroid), refreshes `current_evidence_json` + `last_seen_in_synth`, resets `missed_run_count`. Active focuses NOT bound this run accumulate missed_run_count; ≥3 → `status='dormant'`. Bound focuses with `1 - cos(initial_signature, current_signature) > 0.35` get `drift_flagged_at` stamped (one-shot, cleared on rename). Same body knobs as the probe. Returns `{synth_stats, binding: {bound, dormant_focus_ids, newly_drifted_focus_ids}, persisted}`.
POST /focuses/{id}/rename       → snaps `initial_signature := current_signature` so drift detection re-bases from the new origin; clears `drift_flagged_at`; updates text/endgoal. Body: `{text?, endgoal?}`.
POST /focuses/{id}/fork         → old focus flipped to `status='evolved'`; new Focus spawned inheriting the drifted current_signature as its initial+current, linked back via `evolved_from_focus_id`. Body: `{new_text, new_endgoal?}`.
GET  /focuses/{id}              → single-focus detail. Includes parsed `evidence: [{kind, id, snippet}]` array (current bound state) — used by the dashboard's FocusDrillDown modal. Heavier than the /focuses list endpoint; only fetched on card click.
POST /focuses/{id}/reactivate   → brings a dormant focus back into the active pool. Clears `missed_run_count` + `drift_flagged_at`, sets `status='committed'`. Idempotent.

GET  /health/scores             → 6-axis Gooni-health composite. Each axis returns `{axis, score (0-100), headline, components: [{name, score, weight, detail}]}`. Axes: memory (30% type balance, 30% dedup quality, 40% freshness), chat (40% rolling eval rating, 40% tool-call success rate, 20% inverse feedback rate), engagement (today's user-messages+notes+todos+habit-entries vs 10/day target), availability (50% process uptime, 50% DB-OK), cost (today's claude-turns vs 7d trailing avg, spike inverse), connectors (% of Whoop+GitHub+Google healthy). Driven by `app/services/health_service.compute_all`. Computed on-demand, no caching — drives the Build mode of the dashboard.
GET  /focus-candidates?status=proposed → list candidates (default proposed; pass status='all' to skip the filter). Ordered by confidence desc, seen_count desc.
POST /focus-candidates/{id}/promote → creates a Focus row from the candidate (committed, status='committed'), stamps `promoted_focus_id` + `promoted_at`, flips status to 'promoted'. Idempotent on already-promoted.
POST /focus-candidates/{id}/dismiss → flips status to 'dismissed' + stamps `dismissed_at`. Row stays in DB so the synthesizer's upsert respects the decision on re-emit.

# Habits (daily binary trackers):
GET    /habits                          → active habits + each habit's 7-day strip + current streak (drives `HabitsStrip` dashboard widget).
POST   /habits                          → create. Body: `{name, polarity?, color?}`. polarity defaults to 'positive'.
PATCH  /habits/{id}                     → rename/recolor/archive. Body any of `{name, color, polarity, sort_order, archived: bool}`.
DELETE /habits/{id}                     → hard delete. Entries cascade.
PUT    /habits/{id}/entries/{YYYY-MM-DD} → upsert one day's entry. Body: `{value: bool, note?}`.
DELETE /habits/{id}/entries/{YYYY-MM-DD} → unlog (revert that day to unknown).

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
- **Deferred embedding columns**: `Note.embedding`, `Note.classified_embedding`, `ListItem.embedding`, `Memory.embedding`, `Message.embedding` are wrapped in `deferred()`. ORM hydration skips them — list/read endpoints don't pay the ~31KB-per-row cost. Similarity callers must opt back in via tuple queries (`db.query(Note.id, Note.embedding).all()`) instead of `.query(Note).all()` to avoid an N+1 lazy-load storm. Pattern lives in `note_service.search_by_query`, `list_service.find_similar`, `memory_service` retrieval, and `focus_synthesizer._gather_messages` (lazy-populates `Message.embedding` on first read — messages are immutable post-create so cache never goes stale).

## Known Issues
