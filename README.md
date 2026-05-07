# Gooni

Personal AI accountability companion with persistent memory, lists, focuses, and a notes-first UI. Reachable via web, Telegram, and WhatsApp.

---

## Quick start (all processes)

```bash
./dev.sh
```

Opens a new iTerm2 window with four tabs — backend, frontend, Telegram bot, and Datasette — each running automatically.

---

## Running processes individually

### Backend
```bash
source venv/bin/activate
uvicorn app.main:app --reload
```
Runs at http://localhost:8000. Auto-reloads on file changes.
API docs at http://localhost:8000/docs.

**To restart:** `Ctrl+C` in the backend tab, then run the command again.

### Frontend
```bash
cd frontend
npm run dev
```
Runs at http://localhost:5173.

### Telegram bot
```bash
source venv/bin/activate
PYTHONPATH=. python scripts/telegram_bot.py
```

### Datasette (DB browser)
```bash
source venv/bin/activate
datasette db/gooni.db -p 8002
```
Runs at http://localhost:8002. Browse and query the SQLite DB visually.

---

## First-time setup

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd frontend && npm install && cd ..

cp .env.example .env
# Fill in OPENAI_API_KEY and TELEGRAM_BOT_TOKEN in .env
```

### Reset the database
```bash
rm db/gooni.db
# Restart the backend — it recreates all tables automatically on startup
```

---

## Architecture

```
app/
  main.py                    # FastAPI routes + startup migrations + auth/rate-limit middleware
  db/
    models.py                # Space, Note, Conversation, Message, Memory, List, ListItem,
                             # PublicProfile, Visit, OAuthToken, TrackedRepo
    schemas.py               # Pydantic request models
  services/
    orchestrator.py          # Unified chat handler (web, telegram, whatsapp, imessage)
    note_service.py          # Note CRUD + embeddings + space suggestion + related notes
    conversation_service.py  # Conversation sessions + topic graph + rolling summary
    memory_service.py        # Local SQL memory store; LLM extract → reconcile → cosine retrieval
    item_service.py          # ListItem CRUD (focuses, todos, etc.)
    list_service.py          # List CRUD + LLM context for AddToListTool
    messaging/
      base.py                # MessagingChannel ABC + dispatch_inbound
      telegram.py, whatsapp.py, imessage.py
  llm/
    client.py                # OpenAI wrapper (gpt-4o-mini default, gpt-4o for vision)
  tools/                     # Pluggable LLM tools (lists, feature requests, etc.)

frontend/
  src/
    routes/index.tsx         # Main UI: Sidebar | NotesList | NoteEditor | GooniPanel
    routes/public.*.tsx      # Public portfolio pages (no auth)
    components/notes/
      Sidebar.tsx            # 200px nav (notes + chat sections, draggable order)
      NotesList.tsx          # 260px notes for selected space
      NoteEditor.tsx         # Title + TipTap body, auto-save 1.5s, image paste/drop
    components/Dashboard.tsx # Stats, focuses, dev activity, public bio editor
    components/GooniPanel.tsx# Chat panel (note-aware context)
    stores/                  # Zustand stores (per-feature, persist with versioned keys)
    services/api.ts          # Typed fetch calls
    utils/notePreview.ts     # displayTitle(), HTML strippers — note title fallbacks

scripts/
  telegram_bot.py            # Telegram bot (long-polling). Calls into messaging/dispatch_inbound.

mcp/
  server.py                  # MCP server exposing Gooni to Claude Code via stdio
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Chat responses + embeddings |
| `DATABASE_URL` | No | Defaults to `sqlite:///./db/gooni.db` |
| `AUTH_PASSWORD` | No | When set, blocks non-public routes behind a Bearer-token gate |
| `ALLOWED_ORIGINS` | No | Comma-separated frontend origins for CORS |
| `TELEGRAM_BOT_TOKEN` | Bot only | From @BotFather |
| `TELEGRAM_CHAT_ID` | Bot only | Inbound allowlist; comma-separated chat IDs |
| `WHATSAPP_VERIFY_TOKEN` | WA only | Pick any string; matches Meta webhook config |
| `WHATSAPP_PHONE_NUMBER_ID` | WA only | From Meta API Setup |
| `WHATSAPP_ACCESS_TOKEN` | WA only | System User token, scopes: `whatsapp_business_messaging` + `whatsapp_business_management` |
| `WHATSAPP_APP_SECRET` | WA only | For X-Hub-Signature-256 verification on inbound |
| `WHATSAPP_ALLOWED_HANDLES` | WA only | Comma-separated phone numbers (any format; normalized to digits) |
| `IMESSAGE_BRIDGE_URL`, `IMESSAGE_BRIDGE_PASSWORD`, `IMESSAGE_WEBHOOK_SECRET`, `IMESSAGE_ALLOWED_HANDLES` | iMessage only | BlueBubbles bridge config |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` | Dev Activity panel | OAuth app at github.com/settings/developers |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET`, `R2_BUCKET`, `R2_PUBLIC_HOST` | Image uploads | Cloudflare R2 (S3-compatible). When unset, `POST /uploads/image` returns 503 and the editor falls back to inline base64 data URLs |
| `GOONI_FRONTEND_URL` | MCP only | Public host of the SPA, used by `mcp__gooni__add_note` to surface deep-link URLs (default `http://localhost:5173`). Override in prod with e.g. `https://www.gubith.com` |
