# Ideas

> Random thoughts, features, and things worth exploring

## personal list (AI do not touch)
- can you start tracking .....

## Features

- Todo list management — read, create, update, delete a central todo list (good first tool call)
- Location awareness via Telegram — if the bot knows you're away, Gooni behaves differently
- Proactive check-ins — "you mentioned wanting to sleep better, it's 11pm, lights off?"
- Named modes — "work mode", "movie night", "wind down" as stored presets
- Multi-user support eventually — household members with separate profiles

## Architecture thoughts

- Wake word should be offline / local (Porcupine or Picovoice) — don't send audio to cloud just to detect the trigger word
- Voice latency matters: STT → LLM → TTS needs to feel under 2-3 seconds. Streaming TTS helps.
- Telegram as Phase 3 is the right call — much faster than building a mobile app
- Consider keeping tool results out of episodic memory (don't store "weather today was 72°F" — it'll be wrong tomorrow)

## Open questions

- Should routines be stored as procedural memories or as explicit automation rules in Home Assistant?
- How do we handle conflicting memories? (said "I like it hot" then later "I prefer iced coffee")
  - Current: upsert by key with semantic similarity check — probably good enough
- Is the cost of running memory extraction on every message worth it? Could batch or throttle.
- At what point does SQLite become a bottleneck? Probably not for a while — single household scale.

## Resolved

- ~~Are embeddings stored correctly?~~ — Yes, as JSON strings in SQLite. O(N) search is fine at household scale.
- ~~Is cost calculation correct with multiple API calls?~~ — Each call is tracked separately, session total is summed.
