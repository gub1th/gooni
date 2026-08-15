# Gooni

Personal AI notebook → ambient home assistant. One append-only thought log (web, Telegram, WhatsApp), an extractor that annotates commitment-shaped messages for one-tap promotion to Promises, generic Trackables for anything measurable, and persistent memory retrieved at chat time.

---

## Quick start (all processes)

```bash
./dev.sh
```

Opens a window with backend + frontend tabs (worktree-aware: derives ports + a per-worktree SQLite file).

---

## Running processes individually

### Backend
```bash
source venv/bin/activate
uvicorn app.main:app --reload
```
Runs at http://localhost:8000. Auto-reloads on file changes.
API docs at http://localhost:8000/docs.

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

### Datasette (DB browser, optional)
```bash
source venv/bin/activate
datasette db/gooni.db -p 8002   # pip install datasette first (not in requirements.txt)
```

### Focus MCP server (the claude.ai custom connector)
```bash
# Serves the 6-tool "focus system" over remote streamable-HTTP at http://127.0.0.1:8001/mcp
GOONI_URL=http://localhost:8000 GOONI_AUTH_PASSWORD="$AUTH_PASSWORD" \
  FOCUS_MCP_PORT=8001 FOCUS_MCP_ALLOWED_HOSTS="*" \
  python mcp_servers/focus_server.py

# Expose it publicly (cloudflared, NOT ngrok — ngrok's interstitial breaks the
# OAuth discovery probes), then add the printed URL + /mcp at claude.ai:
cloudflared tunnel --url http://localhost:8001
```
See `docs/focus_connector_instructions.md` for the full connect + auto-logging setup. What Claude writes shows up on the home at http://localhost:5173/ (the kiosk dashboard that used to live at `/focus` was deleted 2026-08-10 — that route is the focus SESSION page now).

### Desktop shell (menu-bar app + capture hotkey + app sensor + focus-cam supervisor)
```bash
cd desktop && npm install && npm start
```
Runs against the **deployed** backend (`https://gooni-bot.fly.dev`) on purpose — a
shell pointed at localhost captures nothing whenever `dev.sh` isn't running. It
puts Gooni in the menu bar, binds a global capture hotkey, records which macOS
app was frontmost (→ `POST /app/intervals`, the OS twin of the browser
extension; needs Accessibility), and supervises the focus-cam Python sidecar
(start/restart/log/clean stop). Unsigned, so macOS re-prompts for permissions
after each rebuild. See `desktop/README.md`.

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
# Restart the backend — alembic walks a fresh DB from baseline to head on boot
```

---

## Architecture

```
app/
  main.py                    # SLIM wiring: middleware (auth/CORS/trace/visit), lifespan, router registry
  background.py              # background loops (note-excerpt backfill, memory watchdog)
  common.py                  # local_today()/local_now() canonical tz, parse_due_hint (ONE deadline parser)
  db/
    models.py                # Note, Promise, Trackable(+Entry), Message, Edge, Memory,
                             # Conversation, ToolCall, Reflection, Settings, Eval*, …
    schemas.py               # Pydantic request models
  routers/                   # one module per API domain — the grep-able route surface
  services/
    orchestrator/            # unified chat handler (web, telegram, whatsapp, imessage)
    memory_extraction/       # extract_signals — ONE LLM call emits promises/fitness/tone/memory
    intent_router.py + intent_handlers/   # dispatch extracted signals to writers
    promise_service.py       # THE actionable primitive (absorbed todos/habits/focuses/reminders)
    focus_service.py         # adapter: focus vocabulary (topics/thoughts/reminders) over Notes + Promises
    trackable_service.py     # generic measurement substrate (Notion-tables model)
    memory_service.py        # local SQL memory: LLM extract → reconcile → cosine retrieval
    overlay_service.py       # deterministic "what matters now" ranker (no LLM)
    eval_service.py          # conversation segmentation + ratings + dispatch-to-Claude-Code
    messaging/               # MessagingChannel ABC + telegram/whatsapp/imessage impls
  llm/
    client.py                # OpenAI wrapper (gpt-5.4 chat, gpt-5.4-mini extract, gpt-4o-mini cheap paths)
  tools/                     # 16-tool chat registry (memory, web, notes, promises read, calendar)

frontend/
  src/
    routes/index.tsx         # app shell: home (THE ambient home) | notes | log | eval
    routes/focus.tsx         # chromeless focus SESSION page (/focus) — reached only from a task row
    routes/public.*.tsx      # public portfolio pages (no auth)
    components/ambient/      # THE home: MorphLine wave · the line · TODAY list · streaks · corner log sheet
    components/ChatLogView.tsx  # append-only thought log w/ glow → promote/dismiss
    components/notes/        # Sidebar, NotesList, NoteEditor (TipTap, auto-save)
    components/eval/         # EvalView (?audit=1)
    components/focus/        # FocusSession (the /focus timer) + GooniAsleep (its idle state)
    stores/                  # Zustand stores (persist with versioned keys)
    services/api.ts          # every fetch call, typed
    ui/                      # design tokens — single styling source of truth

evals/                       # offline regression harness (replays prod snapshot, LLM judge)
scripts/
  telegram_bot.py            # Telegram bot (long-polling) → messaging/dispatch_inbound
mcp_servers/
  server.py                  # legacy 30-tool MCP server → Claude Code via stdio
  focus_server.py            # 6-tool "focus system" MCP → claude.ai connector (remote streamable-HTTP)
extension/                   # Chrome browser-attention sensor (MV3, unpacked; no build step)
                             # → POST /browser/intervals. Install + privacy model: extension/README.md
tests/                       # plain-script tests: signal routing, overlay ranker, import smoke, focus decay + convergence, browser ingest
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Chat responses + embeddings |
| `DATABASE_URL` | No | Defaults to `sqlite:///./db/gooni.db` |
| `AUTH_PASSWORD` | No | When set, blocks non-public routes behind a Bearer-token gate |
| `ALLOWED_ORIGINS` | No | Comma-separated frontend origins for CORS |
| `TAVILY_API_KEY` | Web search | Powers the `web_search` chat tool |
| `GOONI_PROACTIVE_DISABLED` | No | Kill switch for the background proactive loop. Set to `1` to stop it everywhere; WINS over the `proactive_enabled` Settings toggle, so a prod stop never needs a database write |
| `PROACTIVE_INTERVAL_MIN` | No | Proactive loop cadence in minutes (default 15, clamped 5–180) |
| `PROACTIVE_TTL_MIN` | No | How long an observation stays on the ambient display (default 30, clamped 5–720) |
| `PROACTIVE_MODEL` | No | Model for the proactive tick (default `gpt-4o-mini`) — one bounded call per tick, never on a request path |
| `TELEGRAM_BOT_TOKEN` | Bot only | From @BotFather |
| `TELEGRAM_CHAT_ID` | Bot only | Inbound allowlist; comma-separated chat IDs |
| `WHATSAPP_VERIFY_TOKEN` | WA only | Pick any string; matches Meta webhook config |
| `WHATSAPP_PHONE_NUMBER_ID` | WA only | From Meta API Setup |
| `WHATSAPP_ACCESS_TOKEN` | WA only | System User token, scopes: `whatsapp_business_messaging` + `whatsapp_business_management` |
| `WHATSAPP_APP_SECRET` | WA only | For X-Hub-Signature-256 verification on inbound |
| `WHATSAPP_ALLOWED_HANDLES` | WA only | Comma-separated phone numbers (any format; normalized to digits) |
| `IMESSAGE_BRIDGE_URL`, `IMESSAGE_BRIDGE_PASSWORD`, `IMESSAGE_WEBHOOK_SECRET`, `IMESSAGE_ALLOWED_HANDLES` | iMessage only | BlueBubbles bridge config |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI` | Whoop feed | OAuth app; recovery/HRV/sleep land as Trackable entries |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` | GitHub integration | OAuth app at github.com/settings/developers (Settings → Integrations) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET`, `R2_BUCKET`, `R2_PUBLIC_HOST` | Image uploads | Cloudflare R2 (S3-compatible). When unset, `POST /uploads/image` returns 503 and the editor falls back to inline base64 data URLs |
| `GOONI_FRONTEND_URL` | MCP only | Public host of the SPA, used by the MCP `log_note` tool to surface deep-link URLs (default `http://localhost:5173`) |
| `GOONI_URL`, `GOONI_AUTH_PASSWORD` | MCP only | Focus/legacy MCP → backend base URL + password (→ sha256 → Bearer). Set `GOONI_AUTH_PASSWORD` = `AUTH_PASSWORD` so the connector can reach the gated backend |
| `FOCUS_MCP_HOST`, `FOCUS_MCP_PORT` | Focus MCP | Bind for `mcp_servers/focus_server.py` streamable-HTTP transport (default `127.0.0.1:8001`) |
| `FOCUS_MCP_ALLOWED_HOSTS` | Focus MCP | Comma-separated Host allowlist for the transport's DNS-rebinding protection; `*` disables it. Required (or `*`) when serving behind a tunnel — the public Host is 421-rejected otherwise |
