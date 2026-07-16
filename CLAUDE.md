# CLAUDE.md

> Project-specific rules + index. Behavioral defaults (about Daniel, lock-goal, verify-before-push, keep-docs-honest) live in global `~/.claude/CLAUDE.md` — not duplicated here.

## Goal

Gooni = personal AI notebook → ambient home assistant. **Ambient-loop v2 (2026-07, PRD note #389) collapsed the primitive layer to 6 core tables.** The loop:
1. Every thought — web chat, WhatsApp, Telegram, notes — lands in one append-only log with a uniform ack (no dispatch fork at capture time)
2. The extractor annotates commitment-shaped messages with a glow; Daniel promotes them to Promises with one tap (or dismisses); measurements log to Trackables (web matrix, or an explicit whole-basis chat log tool — NOT auto-extracted)
3. A hover-summoned frosted overlay shows what matters right now (deterministic rankers, no LLM)
4. Memory built from notes/chat in SQLite `memories` table (extract → reconcile via LLM, cosine-retrieved at chat time) — KEPT through the v2 nuke (Daniel's override; chat recall is load-bearing)

Mobile capture via bots: Telegram (live), WhatsApp (live), iMessage (code shipped, awaiting Mac+BlueBubbles). All route through `MessagingChannel` ABC in `app/services/messaging/`.

## North Star

Ambient physical assistant — device that knows you passively, surfaces context proactively. Gooni = brain. (`docs/VISION.md` is local-only/gitignored — don't expect it in a fresh clone.)

## Project Rules

- Don't add new features without being asked
- Don't change DB schema without flagging
- Don't install new deps without asking
- **Call `mcp__gooni__add_memory` after meaningful work or product discussion** — code changes, architectural decisions, feature ideas.
- **One-line takeaway per merged PR.** After merge, ask Daniel "what did you learn shipping this?" → write to a Gooni note via `mcp__gooni__add_note`. Title `"PR #N takeaway: <topic>"`. Skip for pure plumbing.
- **Dev-work tracking (post-backlog).** The backlog board died in the v2 nuke. Non-trivial dev work lives as Promises (`mcp__gooni__add_promise`, ideally under a parent like "gooni rewrite") and/or `feature-request`-tagged notes. Track progress via task tools + comments on the driving PRD note.

## Current Priorities

See `docs/TODO.md` (gitignored — local only).

## Core data model (post-v2)

**5 primitives + Memory:**
- `Note` — universal capture atom. Tags (JSON list, lowercase, deduped) replace Spaces for ALL organization. `excerpt` cached preview; `is_draft`/`is_pinned`/`is_public(_pinned)`. `GET /notes` (flat list, `?tag=` filter), `POST /notes`. (The `status` graduation lifecycle + 5am-batch session cols were dropped in the lean sweep `4d9c44f8f546`.) Two placement cols (migration `884013e244b2`): `log_date` (Date, indexed) marks a **daily-log note** — the log-matrix "note" column, one per date, `daily` tag, `GET /notes/daily?days=&end=` + `PUT /notes/daily/{date}` (empty body → delete = cell-clear); `home_pos` (JSON-text `{x,y}` viewport fractions) marks a **sticky note** parked on the ambient home, `sticky` tag, `GET /notes/sticky`. Both are real Notes (searchable, embeddable) — not new primitives.
- `Promise` — THE actionable primitive (absorbs Todo/Habit/Focus). `cadence` (`once|daily|n_per_week|permanent_do|permanent_never`), `cadence_target` (N for n_per_week), `is_important` (user-set; overlay input), `parent_promise_id` (self-FK nesting — a "Focus" is a Promise with children), `inferred_due` (local-EOD anchored, naive UTC), `needs_clarification`, `slip_count` (cosine vs past broken), `source_message_id`, deferred `embedding`. Lifecycle `active → kept|broken`; `auto_mark_overdue` sweeps once-cadence only (recurring never auto-breaks on a date). Chat-side closure via `find_active_match` (substring → unique-word-overlap → cosine ≥0.60; top-2-within-0.05 → ambiguity refusal → "which one?" ack). CREATES from chat do NOT auto-insert — see glow below. `DELETE /promises/{id}` hard-deletes (undo path).
- `Trackable` + `TrackableEntry` — generic measurement (Notion-tables model). Definition: `name` (lowercase-unique), `kind` (`boolean|numeric|json`), `agg` (`sum|last` per-day fold), `unit`, `cadence`, `target`, `is_important`, `schema_hint` (JSON hint incl. optional `direction: limit|floor`), `source` (`manual|chat|whoop|leetcode|derived`), `parent_promise_id`. Entry: sparse `value_boolean|value_numeric|value_json` + `(trackable_id, date)` index; multiple rows/day legal. New tracked thing = one INSERT. 8 system trackables (calories/protein sum-agg; weight/exercise/alcohol/weed/vape/note last-agg) + feed masters (`whoop`, `leetcode` json) + numeric mirrors.
- `Message` — the log substrate. Slice 3 glow cols: `has_actionable_signal` (sticky extractor verdict) + `signal_preview` (JSON `{signals, status: pending|promoted|dismissed, promise_ids}`). `GET /messages/log` = flat newest-first stream across all conversations w/ source badge. `POST /messages/{id}/promote` (runs `promise_service.create_from_signal` per draft), `/undo-promote` (hard-deletes exactly those promises, restores pending), `/dismiss-glow`. `GET /messages/{id}/trace` = full per-turn audit bundle (orchestrator step trace off `Message.trace` + `ToolCall` audit rows by message_id + paired user utterance + post-turn `Reflection`); assembles data that already existed keyed to the assistant message — powers the recent-chat ribbon's audit panel.
- `Edge` — semantic graph (`utters`, `derives_from`, …). UNIQUE on the 5-tuple; promise deletion clears its edges.
- `Memory` — KEPT (Daniel's override). Reconcile dance + cosine retrieval + MCP tools unchanged; the capability prompt block is gone (OBJECT_KINDS is the remaining anti-hallucination anchor). **Provenance (migration `c7e9a1f4b2d8`, 2026-07-12):** `source_message_id` (nullable FK → messages.id) is the chat twin of `source_note_id` — set to the user-utterance id in `_apply_add`, threaded from `orchestrator/core.py` (both reconcile trigger sites pass `user_msg.id` into the daemon `apply_memory_candidates` thread; the note path rides `RouterContext.source_message_id`). `GET /memories` resolves either id into a displayable `source` object (`_attach_sources` = 2 batch queries: Message preview + Conversation channel, or Note title); `null` for pre-provenance chat memories + injected prefs. `/memories` row surfaces it via `SourceTrace` (note → opens note; chat → reveals the source utterance inline). Forward-only — old memories stay null (unbackfillable).

**Infra kept:** `Conversation`, `ToolCall` (audit), `WaProcessedId`, `Attachment` (note-owned only now), `Reflection` (deterministic guards; facet promotion removed), `PublicProfile`, `Visit`, `OAuthToken`, `Settings`, `EvalSegment`/`EvalStepFeedback`/`EvalMessageRating`, `Trackable(Entry)`.

**Nuked (migration `e8b3c6d9f2a7`, 2026-07-09):** Space, List, ListItem, Todo, Focus, FocusCandidate, Habit, HabitEntry, BacklogTicket, FocusSession×3, FrictionEvent, GooniTake, McpCall, ClaudeUsageTurn, CapabilityFacet, NoteComment, Reaction, DailyMetric (rows pre-migrated to TrackableEntry in `f3b8d1c6a9e2`), GooniSnapshot, TrackedRepo (+ WhoopSnapshot/LeetcodeSnapshot in `d2f5a8c1e9b3`). Nuclear — git is the rollback. The lean sweep (`4d9c44f8f546`, 2026-07-10) finished the job: dropped the 25 orphan columns the nuke stranded (Settings nudge/idle cols, Note graduation/session cluster, unmapped FK leftovers).

## API surface

Route shapes are grep-able — one `app/routers/<domain>.py` module per domain (`visits, public, metrics, trackables, overlay, auth, misc, chat, speech, webhooks, settings, notes, promises, uploads, conversations, health, tool_calls, mcp, memories, eval, whoop, integrations, reflections`). Serialization in `app/serializers.py`. `speech` = `POST /tts` (text → MP3 bytes via OpenAI `tts-1`, voice `fable`; best-effort, 502→client stays silent). `integrations` = Google Calendar events CRUD (`GET`/`POST`/`PATCH`/`DELETE /calendar/events`, thin wrappers over `services/google_calendar.py`; `_serialize_event` flattens Google's start.dateTime-vs-start.date union into `{start, end, all_day}`) + GitHub. 401 = calendar not connected.

## Architecture

### Backend (`app/`)

- **`app/main.py`** — SLIM wiring: middlewares (auth Bearer, CORS, req-trace, visit-log), `_lifespan` (eval pending backfill, fly-revive, then background loops), `_alembic_upgrade`. **Background loops in `app/background.py`**: note-excerpt backfill + memory watchdog ONLY — the nudge scheduler + proactive tick died in the 2026-07 proactiveness reset. Routers never import from `main`.
- **`app/db/models.py`** — see Core data model above.
- **`app/common.py`** — date parsers + auth-token + `local_now(db)`/`local_today(db)` (canonical tz-aware "today" in `Settings.nudge_tz` — legacy column name, the tz survived the nudge nuke; NEVER `date.today()` — server runs UTC) + `parse_due_hint(hint, db)` — THE one deadline parser (regex map + dateparser fallback, local-EOD anchored). `promise_service._infer_due_from_text` scans utterances and delegates here; never grow a second resolver.
- **`app/services/embedding_utils.py`** — `embed_text` + `cosine`, THE shared embedding surface (extracted from dead list_service). All cosine matchers (promises, memory, feature dedup) go through it.
- **`app/services/memory_service.py`** — unchanged reconcile/retrieval core. Retrieval = always-included prefs + top-5 cosine (no capability block anymore). `MIN_QUERY_LEN` read gate stays tiny.
- **`app/services/memory_extraction/`** — single LLM call per turn (`extract_signals`, gpt-5.4-mini, max_tokens=1500) emits `tone_corrections`, `feature_requests`, **`promises`** (unified emit: kind=`create|complete|break`; create carries utterance/summary/cadence/cadence_target/due_date (absolute, clamped today..+366d)/due_hint/is_important/parent_hint; recurring cadences are stripped of due dates — a due on a daily promise is a parse artifact), `reply_intent`, memory candidates. (Fitness/`fitness_logs` extraction was REMOVED — the calorie-guessing auto-writer was Claude-competitive NLP; trackable logging is now the explicit `log_trackable_entry` tool. `_normalize_fitness` + `_MACRO_ESTIMATE_PROMPT` gone.) Prefilter gates note-saves only.
- **`app/services/intent_router.py`** + **`intent_handlers/`** — single dispatch. Handlers: `memories`, `features` (→ `feature-request`-tagged Note via `create_feature_request_note`, tiered dedup), `tones`, `promises` (create → GLOW annotation on the source Message + `RouterResult.noticed_promises`; complete/break → auto-transition). (The `fitness` handler was DELETED with the fitness-intent pipeline — trackable writes are now the `log_trackable_entry` tool, not router-captured.) `RouterResult`: `captured_promises/noticed_promises/completed_promises/broken_promises/failed_promise_actions/captured_features/tone_rules/reply_intent`.
- **`app/services/promise_service.py`** — create (dedup ≥0.85, slip ≥0.80, utters edge), `create_from_signal` (due resolution + parent hint — shared by promote route), `find_active_match`, `resolve_parent_hint`, `transition`, `delete` (row + edges), `auto_mark_overdue` (once-cadence only), `update` (text/due/importance/cadence).
- **`app/services/promise_evaluator.py`** — deterministic voice-of-reason checks (unchanged; conflicts-active band 0.72).
- **`app/services/trackable_service.py`** — generic CRUD + `log_entry` (append / `replace=True` cell-collapse) + `day_value`/`pivot`.
- **`app/services/daily_metric_service.py`** — fitness-semantics ADAPTER over Trackable rows (legacy signatures + response shapes: `log`, `running_total_for_today`, `today_food_ledger`, `update_most_recent`, `set_cell`, `cut_table`, `list_entries`). `/metrics/*` routes ride on it; CutTable FE contract unchanged.
- **`app/services/overlay_service.py`** + **`routers/overlay.py`** — `GET /overlay`: 4 deterministic zones w/ `reason` strings (action_horizon: overdue → due ≤48h → important; trackables_today: met/missed/logged/pending, direction from schema_hint else protein=floor/limit; anchor note; whoop_select from `Settings.overlay_whoop_keys`).
- **`app/services/whoop.py`** — OAuth + client unchanged; storage = `whoop` json master Trackable + numeric mirrors, replace-mode per local day. `get_today`/`latest_snapshot` read back dicts. `/whoop/today` shape unchanged.
- **`app/services/leetcode_service.py`** — same pattern (`leetcode` master + mirrors, per UTC day).
- **`app/services/orchestrator/`** — `core.py` (persona v9: promise-first language, glow NOTICED-not-tracked guardrail, anti-hallucination now backs write-claims by [just extracted] id OR a successful write-tool call), `prompt_blocks.py` (`OBJECT_KINDS_BLOCK` auto-derived from the 17-tool registry × `_CREATE_TOOL_KINDS` (incl. `log_trackable_entry`→`TrackableEntry`) + `_ROUTER_CREATED_KINDS`=`("Promise",)`; `_build_ack` promise/feature acks; `_build_just_extracted_block` w/ NOTICED lines; `_build_state_block` = promise-first: due ≤24h named, important named, rest counted + vague list + calendar + recent activity + food ledger), `steps.py` (verify rail; `_READ_ONLY_TOOLS` tracks the new registry — `log_trackable_entry` is a WRITE so it backs "logged" claims).
- **`app/services/reflexion_service.py`** — ONE deterministic guard: hallucination cross-ref (write-claim regex × ToolCall audit + router captures). Voice-spec regexes deleted in the lean sweep (verbatim-phrase lists, zero recall on novel phrasing, nothing consumed the rows). Rows still embed for history.
- **`app/services/recent_activity.py`** — the `[recent — last 1h]` state-block PUSH. Now a thin RENDERER over `activity_service.build_activity_feed` (the SAME union that powers the rail — one stream, two consumers). Narrowings vs the rail: `exclude_kinds={"message"}` (chats already in convo history), `calories`/`protein` dropped (food ledger owns them), feed lines (whoop/leetcode) stripped to the event ("whoop synced" — numbers stay a pull). NO raw ids.
- **PROACTIVENESS: none, by design (2026-07 reset).** `todo_nudge.py` (daily digest) + `proactive_nudge.py` (whoop/sleep pings) are DELETED — Gooni sends zero unprompted messages. The next proactive system starts from scratch around asymmetric value (surface what Gooni knows that Daniel doesn't; event-driven > schedule-driven; per-day cap). `fly_revive` boot apology is crash-recovery UX, not proactiveness — it stays.
- **`app/services/eval_service.py`** — segments/ratings unchanged; dispatch writes a `claude-code`+`eval-dispatch`-tagged Note + a review Promise (Space + backlog targets died).
- **`app/services/health_service.py`** — 6 axes; engagement counts promises/trackable entries; cost proxies on ToolCall rows; whoop connector reads the master Trackable; github connector = token-only.
- **`app/tools/`** — 17-tool chat registry: memory (save), web (fetch/search), notes (search/add w/ tags/find/read/recent), `list_promises` (read), `read_trackable` (read) + **`log_trackable_entry`** (explicit WHOLE-BASIS write — sets the day via `replace=True`, no calorie-guessing; get-or-creates the 8 system trackables, other names must pre-exist; replaced the removed fitness auto-extractor), `request_feature` (→ tagged Note), calendar (5). Promise writes stay router-driven (glow/complete).
- **Greeting fast-path** + **tool-history in recent_history** — unchanged.
- **`app/llm/client.py`** — gpt-5.4 chat, gpt-5.4-mini extract, gpt-4o-mini cheap paths. `transcribe` (Whisper, unused by web) + `synthesize_speech(text, voice="fable")` (TTS → MP3 bytes, powers `/tts`).

### Frontend (`frontend/src/`)

- **`ui/`** — tokens (`FONT`, `color`, **`frostInk`** = theme-INDEPENDENT dark-frost ink+surface palette that mirrors `color`'s key shape so a legacy light surface migrates by swapping the import (`color as ctok` → `frostInk as ctok`); `.sheet` = solid dark root base for a full-surface dark-frost route that sits inside the theme-following `sheetFrame`; powers the eval/memories/`TurnTracePanel` audit surfaces, `z` ladder incl. `overlay: 950`, `ambient` = overlay-blur + glow-dot, **`frost`** = the 3 sanctioned frosted-surface levels chrome/panel/sheet + **`sheetFrame`** = the floating-window frame every non-home view renders inside), Button/Card/Modal. Never hand-roll rgba+blur for summoned chrome — pick a frost level. Surfaces that float on the black void (audit/eval/memories) read `frostInk`, NOT `color` (which follows theme → goes white in light mode on the black void).
- **`routes/index.tsx`** — THE app shell: view union `home|notes|log|eval`, **default = home** (the ambient waveform). `?view=log` = ChatLogView; **stats retired** (absorbed by the log surface); **full chat view retired** (the `?view=chat` `ChatView` SSE surface + its nav entries were cut; the floating orb was removed 2026-07-12 — the ambient home is now the only conversational surface). No dashboard, no lists.
- **`components/ambient/`** — the presence home (`AmbientHome`). **Voice-first (default on, persisted `gooni_voice_mode`):** tap-to-wake (one required browser gesture — unlocks mic + audio autoplay) → continuous Web Speech STT → auto-send on speech pause → Gooni speaks the reply (TTS via `services/speech.ts::speakText`, subtitle held until audio ends) → resumes listening. Mic pauses during Gooni's reply (no echo) + on textarea focus. `voice`/`silent` pill toggles it; off = typed-only. Recognizer callbacks read `voiceMode`/`armed`/`busy` via REFS (the SpeechRecognition object binds once — state would freeze at first render). ONE morphing line (`MorphLine`) is the breathing waveform at rest and bends into the capture input's outline (wave bbox = hover zone = box, one rect). Omnibox recall on the box (title-substring instant + semantic on pause → note suggestions; ↑/↓+Enter opens `NotePeek` inline reader; plain Enter commits). `LogDots`+`LogTable` = the log surface: a frosted dots card (today's trackables + whoop/leetcode read-only feed tiles) that morphs into a full editable matrix (dates × trackables, historical cells via `logTrackable` date+replace). Matrix extras: **clearing** a numeric cell (empty the field → valueless `replace` deletes the row → "–"; the old code no-op'd on empty so stale values got stuck); **infinite scroll** back in time (scroll near bottom → page an older window via the `end=` param, append to the spine); rightmost **note column** = per-day daily-log Note (inline text edit → `PUT /notes/daily/{date}`); **boolean tags** = a faint per-day label on a logged boolean (exercise → "push"/"legs"), rides `TrackableEntry.value_json.label`, surfaced by `pivot` as `days[].label` — the tag slot only appears once the dot is green (invisible on untagged/off days), and every label write MUST resend `value_boolean:true` since `replace=true` collapses the day. `StickyLayer` = double-click an empty patch of the home void → a draggable frosted sticky Note (`frost.panel`, `home_pos` fractions); type→persists, empty+blur→discarded; drag anywhere except the centre box + left nav zones. `SummonedNav` (frosted edge nav), `LimboCards` (pending-glow), `TracedOutline`. `ActivityRail` = the unified activity log (chats every channel + notes + promise events + trackables via `fetchActivity`), a compact DIMMED block centered UNDER the wave + trackable pill (was a full-height right sidebar; moved centered-under-wave 2026-07-16) — newest at top, ~4 rows at rest, hover brightens it to full opacity, scroll down within the window pages back through history (`before` cursor), 20s poll prepends new; bare text on the void, NO frost; positioned via a `RailAnchor` prop owned by `AmbientHome`; per-turn audit icon → `TurnTracePanel` — a **glance-first** flow-viz of the pipeline (frosted sheet on the void): a vertical spine, one node per stage rendering its *essence* (pipeline `v14` chip · Extract signal-count pills + `reply:` intent · Recall `prefs · similarity` + split-bar · Prompt `chars · msgs` · Reply text + ms · conditional Tool/Reflexion nodes), reading the trace's canonical `output`/`meta` (not the crippled legacy `detail`). ONE deep-dive: `⤢ read prompt` → modal with JSON escapes decoded to real newlines. `full audit ↗` footer resolves `message → segment` (`GET /eval/segment-for-message/{id}`, range-match on `[start_message_id, end_message_id]`) → navigates `?audit=1&segment=N`. Intentionally NOT the eval page: no flag/rating, glance not forensics. Data via `GET /messages/{id}/trace`. Current-day scope only, live-polled — nothing persists.
- **`components/widgets/`** — generic draggable home-widget system. `Widget.tsx` = the shell (spread `frost.panel` + drag lifted from the `FloatingModal` pointer-capture pattern + header expand/hide). `registry.tsx` = THE extension point: adding a widget = append one `{id,title,Icon,defaultEnabled,Compact,Panel?}` entry, everything downstream derives (host, nav, settings). `WidgetHost` renders each enabled widget's `Compact` as a draggable card on `AmbientHome`; `WidgetOverlays` (mounted in AppShell) is the global host for the full `Panel` overlay, summoned from a compact's expand OR the nav. First widget = **Calendar** (`CalendarWidget` compact glance + `CalendarPanel` = Monday-week grid w/ ←/→ paging + agenda + create/edit/delete over gcal; local-tz day bucketing in `calendarDates.ts`). Stores: **`useWidgetLayoutStore`** (persisted per-widget `{positions, enabled}`; absent `enabled[id]` = registry default) + **`useWidgetOverlayStore`** (ephemeral: which panel is open + a `rev` mutation tick compacts refetch on). App nav auto-lists every widget with a `Panel`; **Settings ▸ Widgets** toggles them.
- **`components/ChatLogView.tsx`** — the append-only Thought log (`?view=log`): glow dots, peek panel (cadence pill/due/importance), Promote/Dismiss, 10s undo, source badges, 15s poll. Mounts AmbientOverlay. Seam test `ChatLogView.test.tsx` (vitest + RTL; `npm test`, in CI).
- **`components/AmbientOverlay.tsx`** — corner toggle → frosted edge panels (200ms fade), 4 zones, anchor note picker (persists via Settings PATCH).
- **Stats retired** — `StatsLite`/`StatsView` deleted; the log surface (`LogDots`/`LogTable`) owns trackables + whoop/leetcode feed tiles now. `?view=stats` dead, pulled from all nav.
- **Chat surface = ambient home only** — `ChatView` + `components/chat/{InputBar,MessageBubble}.tsx` were retired earlier; the floating `GooniPanel` orb (`ChatLauncher`/`GooniLayer`/`GooniMascot`/`GooniMascot2D`/`PublicChatLauncher`) + the "gooni's face" selector + their stores (`useGooniStore`/`useGooniFaceStore`/`useChatLauncherRectStore`/`useGooniModalCornerStore`/`useMascotOutStore`) + orphans (`AuraOrb`/`ModelSelector`/`ThinkingIndicator`) were **removed 2026-07-12**. The ambient home (voice + omnibox capture + `ActivityRail` log) is the SOLE conversational surface — `AmbientHome` sends via `createConversation` + `sendConversationMessage` API calls DIRECTLY (holds its own conv id), so `useConversationsStore` + `useModelStore` were deleted too (fully vestigial once the orb went — the store's state was write-only). KEPT: `GooniLogo` (static SVG branding — notes sidebar, `PasswordGate`, comment avatars), `useGooniThemeStore` (light/dark), `GLTFGooni` (the `/creative` 3D character, NOT the orb). Public profile page also lost its walking mascot + visitor chat launcher.
- **`components/notes/Sidebar.tsx`** — the NOTES BROWSER only (All/Pinned/Drafts/Recent + tag filter + Public/MCP footer); mounts only inside the notes sheet. **App nav is ONE rail: `SummonedNav`** (hoisted to AppShell, renders on every authed surface incl. Audit entry). Unification pass 2026-07-10: non-home views render as frosted sheets floating on the black void (`sheetFrame`), Esc drops any sheet back to the ambient home (skips inputs + open dialogs). The waveform does NOT render under sheets (GPU cost) — the void + frost carries the visual continuity.
- **`components/eval/EvalView.tsx`** — kept on `?audit=1` (Daniel's override).
- **`components/SettingsPanel.tsx`** — General tab: timezone only (the one surviving Settings knob). `SettingsModal` tabs = Profile/Appearance (light/dark theme ONLY — the "gooni's face" mascot selector was removed 2026-07-12 with the orb)/General/**Widgets** (per-registered-widget on/off toggles → `useWidgetLayoutStore`)/Integrations/Deployments. `components/dashboard/` deleted in the lean sweep (zero importers).
- **`stores/`** — `useNotesContentStore` (all notes live in the single "general" bucket), theme store (`useGooniThemeStore`). Spaces/Lists/Ordering + `useConversationsStore`/`useModelStore` (orb-era chat state) dead.
- **`services/api.ts`** — surviving fetchers only; `fetchSpaceNotes`/`createNote` are flat `/notes` calls (legacy signatures).

### MCP Server (`mcp/server.py`)

**Memory**: `get_context`, `add_memory`, `list_preferences`, `search_memories`, `edit_memory`, `forget_memory`
**Notes**: `add_note` (tags; auto-tags `from-claude`+`claude-code`), `search_notes`, `edit_note`, `find_note`, `read_note`, `delete_note`, `list_notes` (tag filter), `list_recent_notes`, `attach_file_to_note`
**Note checklists**: `read_todos` (the 'todo'-titled note), `check_task`, `claim_task`, `release_task`
**Promises**: `add_promise` (cadence/target/important/due), `read_promises`
**Trackables**: `add_trackable`, `log_trackable_entry`, `read_trackable`
**Stats**: `get_leetcode_activity`
Killed in the nuke: all Todo/Focus/Habit/Backlog/List/Space/Comment/CapabilityFacet tools.

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
cd frontend && npm test                  # vitest + RTL seam tests (gates CI via frontend-lint.yml)
source venv/bin/activate && python -c "from app.main import app; print('OK')"
python tests/test_imports.py             # import smoke: EVERY module under app/+evals/+scripts/ — catches lazy-import breakage table nukes leave behind
python tests/test_signal_routing.py      # extract→dispatch→DB net (no LLM)
python tests/test_overlay.py             # deterministic ranker net
```

## Schema changes (Alembic)

```bash
# After editing app/db/models.py:
source venv/bin/activate
alembic revision --autogenerate -m "what you changed"
# Review the generated file. SQLite quirks: Boolean→INTEGER (cosmetic),
# DateTime→TEXT (cosmetic), missing FK constraints (SQLite doesn't enforce).
alembic upgrade head
# Commit the new revision alongside the model change.
```

`alembic upgrade head` runs on uvicorn boot via `_alembic_upgrade()`. Fresh DBs walk from baseline to head. **Half-applied-state recovery:** boot catches "already exists" OperationalErrors and stamps to head. **Migration-author conventions:** inspector guards (`has_table` / column checks) so re-runs are no-ops; `if_not_exists=True` on create_index. **Dropping columns whose FK targets are already-dropped tables:** batch_alter reflects the table and follows FKs → `NoSuchTableError`; stand up empty phantom parents for the rebuild, drop indexes touching the doomed columns first, drop phantoms after — see `4d9c44f8f546` for the working pattern.

## Code Patterns

- **Zustand persist**: bump key on shape change to avoid stale state
- **Module-style services**: most `app/services/*.py` are function modules (or one instance at bottom)
- **FastAPI `db: Session = Depends(get_db)`** — session per request
- **Optimistic UI**: `createNote` adds temp note, replaces w/ API response
- **React StrictMode**: kept intentionally
- **hasChanges ref**: NoteEditor only saves if the user typed
- **Public routes** `/public` + `/public/$noteId` standalone (no sidebar/auth); grouping label = first tag
- **Deferred embedding columns**: `Note.embedding`, `Note.classified_embedding`, `Memory.embedding`, `Message.embedding`, `Promise.embedding` wrapped in `deferred()`. Similarity callers MUST use tuple queries.
- **Deterministic > LLM** for anything user-facing that ranks/surfaces/promotes (overlay, glow, matchers). LLM only parses.
