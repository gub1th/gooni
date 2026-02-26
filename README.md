# Gooni

A personal home AI assistant with persistent memory. Not a generic chatbot — a brain that learns who you are over time and eventually lives in your home.

## What's working today

- **Conversational AI** with full conversation history in context
- **Profile memory** — structured facts about you (preferences, goals, routines) extracted automatically from conversation and stored persistently
- **Episodic memory** — past conversations stored as embeddings, retrieved by semantic similarity
- **CLI** with animated thinking states, interactive memory management, and cost tracking

## Running it

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Add your OPENAI_API_KEY to .env

python scripts/cli.py
```

The API server (for dev/debug):
```bash
uvicorn app.main:app --reload
# Docs at http://localhost:8000/docs
```

## CLI commands

| Command | Description |
|---|---|
| `/profile` | View profile memories, select to delete |
| `/episodic` | View recent episodic memories |
| `exit` / `quit` | End session with summary |

## Debug endpoints

- `GET /debug/memories/profile` — all active profile memories
- `GET /debug/memories/episodic` — all episodic memories

## Architecture

```
scripts/cli.py              # CLI interface
app/
  main.py                   # FastAPI endpoints
  services/
    orchestrator.py         # Chat flow coordinator
    memory_service.py       # Episodic memory (vector search)
    profile_memory.py       # Profile memory (structured facts)
    memory_extraction.py    # LLM-based memory extraction
    interaction_service.py  # Conversation history
  llm/
    client.py               # OpenAI integration
  db/
    models.py               # SQLAlchemy models
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | For chat responses and embeddings |
| `DATABASE_URL` | No | Defaults to `sqlite:///./db/gooni.db` |
