# Roadmap

## Phase 1 — Brain ✅ (foundation complete)

The memory and reasoning foundation. Deliberately kept simple to move fast.

**Done:**
- FastAPI backend + SQLite
- LLM-based profile memory extraction (structured: key / value / type / confidence)
- Episodic memory with vector similarity search (cosine, stored as JSON embeddings)
- Conversation history passed to LLM context
- CLI with animated thinking states, interactive /profile picker, cost tracking

**Intentionally deferred (can revisit later):**
- Memory consolidation (promoting episodic patterns → profile facts over time)
- Confidence feedback loops (user corrections updating confidence scores)
- Memory forgetting / decay curves
- Procedural memory ("when X, always do Y")

---

## Phase 2 — Voice + Tool Calls 🔄 (next)

Turn it from a chat app into something that can act in the world.

**Voice:**
- STT: Whisper API — you speak, it transcribes
- TTS: OpenAI TTS — it speaks back
- Wake word (later, when moving to physical device)

**Tool call framework:**
- LLM decides when to call a tool vs. respond normally
- Tools are registered functions the orchestrator can invoke

**Initial tools:**
- Web search
- Weather
- Timer / reminder
- Todo list
- Home Assistant bridge (first IoT foothold)

---

## Phase 3 — Mobile / Real-World Access

You shouldn't need to be at home to talk to Gooni.

- **Telegram bot** — fastest path to mobile, no app to build, works globally
- Brain API stays on server, Telegram is just the I/O channel
- Location-aware behavior: knows when you're home vs. away

---

## Phase 4 — Home Integration

The brain starts controlling the environment.

- Home Assistant as device bridge (lights, thermostat, etc.)
- Natural language → device commands with memory context
- Memory-driven automation ("movie time" → learned preferences applied)
- Proactive suggestions from detected patterns

---

## Phase 5 — Physical Device

Gooni gets a body.

- Raspberry Pi + mic + speaker
- Wake word detection ("Hey Gooni")
- Always-on, room-aware
- Potentially multi-room

---

*Phases 3-5 will be refined as Phase 2 gets built. Don't over-plan ahead.*
