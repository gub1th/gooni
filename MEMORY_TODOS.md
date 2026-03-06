# Memory System — Known Flaws

- `search_similar` loads every embedding from SQLite into RAM on every query. Fine now, breaks at scale.
- Memories are only saved when the LLM explicitly calls a memory tool. It misses things.
- No auto-extraction — subtle facts ("I prefer mornings") can be dropped entirely if the LLM skips the tool call.
- No categorization or clustering. All memories are a flat list.
- No tagging on memories (topic, entity type, etc).
- Embeddings stored as raw JSON strings in SQLite instead of a proper vector index. Slow to query.
- No per-message memory pass — only episodic saves happen automatically, profile facts require tool calls.
