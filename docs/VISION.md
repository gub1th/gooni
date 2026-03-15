# Vision & Ideas

> A personal AI that lives in your home, knows you deeply over time, and makes your environment respond to you — not just a smart speaker, but a brain.

## The core idea

Most smart home devices are stateless command routers. They respond to commands but don't know you. Every interaction starts from zero. Gooni is different: it builds a persistent model of who you are — your preferences, routines, goals, habits — and that model deepens over time.

The moat isn't device control. Anyone can turn a light on. The moat is *knowing when to* without being asked.

## The interfaces

Gooni is one brain, multiple access points:

- **Web UI** — notes-first, Jarvis always accessible (current)
- **CLI** — development and testing
- **Telegram** — on your phone, in the real world, away from home
- **Voice** — hands-free, in-room, feels like Jarvis
- **Physical device** — a Raspberry Pi with a mic and speaker, always on, wake-word activated

## The home integration

Rather than building device integrations from scratch, [Home Assistant](https://www.home-assistant.io/) acts as the device layer. It already speaks to thousands of devices (Hue, Nest, Matter, Z-Wave, etc.). Gooni is the reasoning layer on top — Home Assistant handles the plumbing.

## What makes it intelligent

- **Memory** — it remembers what you told it a month ago
- **Context** — it knows the time, your patterns, whether you're home
- **Reasoning** — "make it cozy" becomes dim lights + warm temperature + soft music, learned from how you've set things before
- **Proactivity** — it initiates. "You usually wind down around now, want me to dim the lights?"

## What this is not

- A replacement for Home Assistant (it uses it)
- A general-purpose AI product (it's personal, built for one household)
- Finished (it's being built)

---

## Feature ideas

- Todo list management — read, create, update, delete a central todo list (good first tool call)
- Location awareness via Telegram — if the bot knows you're away, Gooni behaves differently
- Proactive check-ins — "you mentioned wanting to sleep better, it's 11pm, lights off?"
- Named modes — "work mode", "movie night", "wind down" as stored presets
- Multi-user support eventually — household members with separate profiles

## Architecture thoughts

- Wake word should be offline / local (Porcupine or Picovoice) — don't send audio to cloud just to detect the trigger word
- Voice latency matters: STT → LLM → TTS needs to feel under 2-3 seconds. Streaming TTS helps.
- Telegram as mobile access is the right call — much faster than building a mobile app
- Consider keeping tool results out of episodic memory (don't store "weather today was 72°F" — it'll be wrong tomorrow)

## Open questions

- Should routines be stored as procedural memories or as explicit automation rules in Home Assistant?
- How do we handle conflicting memories? (said "I like it hot" then later "I prefer iced coffee")
  - Current: upsert by key with semantic similarity check — probably good enough
- Is the cost of running memory extraction on every message worth it? Could batch or throttle.
- At what point does SQLite become a bottleneck? Probably not for a while — single household scale.
- Are the hardcoded `meals` and `workouts` tables the right model, or should everything flow through the flexible `Memory` entity?

## Resolved

- ~~Are embeddings stored correctly?~~ — Yes, as JSON strings in SQLite. O(N) search is fine at household scale.
- ~~Is cost calculation correct with multiple API calls?~~ — Each call is tracked separately, session total is summed.
