# TODO & Roadmap

## Active
- (nothing in progress)

## Up Next
- [ ] Deploy Telegram bot
- [ ] Set up Alembic for versioned DB migrations (currently using manual `_run_column_migrations()` in `main.py` — no version tracking, no rollback). On prod, data migrations must be run manually over SSH before restarting the service. Note: SQLAlchemy stores enum values by member **name** (e.g. `FACT`, `EPISODE`) not by `.value` — use uppercase in raw SQL migrations.

## Backlog
- [ ] Note search — filter NotesList by title/content as you type
- [ ] Gooni memory context — include top-3 relevant memories in Gooni prompt (not just active note)
- [ ] Telegram → note sync: messages captured via Telegram appear as notes in relevant space
- [ ] Keyboard shortcut: ⌘N creates a new note in the current space
- [ ] Mobile: Gooni panel as a bottom sheet on narrow screens
- [ ] Dark mode
- [ ] GoalView redesign — living document feel, inline note creation, blockers as one-liner
- [ ] Memory refactor — replace hardcoded meals/workouts tables with flexible Memory entities

## Done
- [x] 3-panel Apple Notes layout (Sidebar + NotesList + NoteEditor)
- [x] Gooni panel with note context
- [x] Note CRUD (create, auto-save, delete)
- [x] Space selection persisted across refreshes
- [x] Memory episodes saved on note update
- [x] Note delete — right-click context menu with two-step confirm
- [x] Space delete — context menu with confirm, cascades to notes
- [x] Emoji picker for spaces
- [x] Goals feature — sidebar section, GoalView, milestone tracking, Gooni briefing
- [x] Note → goal linking via 🎯 chip in NoteEditor

---

## Roadmap

### Phase 1 — Brain ✅
- FastAPI backend + SQLite
- LLM-based profile memory extraction (key / value / type / confidence)
- Episodic memory with vector similarity search
- Conversation history passed to LLM context

**Deferred (revisit later):**
- Memory consolidation (episodic patterns → profile facts over time)
- Confidence feedback loops
- Memory forgetting / decay curves
- Procedural memory ("when X, always do Y")

### Phase 2 — Voice + Tool Calls 🔄 (next)
- STT: Whisper API
- TTS: OpenAI TTS
- Wake word (when moving to physical device)
- Tool call framework — web search, weather, timer, todo, Home Assistant bridge

### Phase 3 — Mobile / Real-World Access
- Telegram bot as mobile I/O channel
- Location-aware behavior

### Phase 4 — Home Integration
- Home Assistant as device bridge
- Natural language → device commands with memory context
- Memory-driven automation

### Phase 5 — Physical Device
- Raspberry Pi + mic + speaker
- Wake word detection ("Hey Gooni")
- Always-on, room-aware

---

## Memory System — Known Flaws

- `search_similar` loads every embedding from SQLite into RAM on every query. Fine now, breaks at scale.
- Memories only saved when LLM explicitly calls a memory tool — misses subtle facts.
- No auto-extraction — "I prefer mornings" can be dropped if LLM skips the tool call.
- No categorization or clustering — all memories are a flat list.
- No tagging (topic, entity type, etc).
- Embeddings stored as raw JSON strings in SQLite instead of a proper vector index.
- No per-message memory pass — only episodic saves happen automatically, profile facts require tool calls.
