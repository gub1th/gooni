# Focus system — connector setup + auto-logging

How to wire the `mcp/focus_server.py` connector into claude.ai so you log to Gooni just by talking — no "log a thought" incantation.

## 1. Run the server + tunnel

```bash
# Backend already running on :8000. Then:
cd <repo>
export $(grep -E '^AUTH_PASSWORD=' .env | xargs)
GOONI_URL=http://localhost:8000 \
GOONI_AUTH_PASSWORD="$AUTH_PASSWORD" \
FOCUS_MCP_PORT=8001 \
FOCUS_MCP_ALLOWED_HOSTS="*" \
python mcp/focus_server.py            # → http://127.0.0.1:8001/mcp

# In another tab, expose it — use cloudflared, NOT ngrok (see below):
cloudflared tunnel --url http://localhost:8001   # → prints https://<random>.trycloudflare.com
```

Two load-bearing env vars:
- `GOONI_AUTH_PASSWORD="$AUTH_PASSWORD"` — makes the server's Bearer token match the gated backend so it can actually reach `/focus/*`.
- `FOCUS_MCP_ALLOWED_HOSTS="*"` — the streamable-HTTP transport has **DNS-rebinding protection** that 421-rejects any request whose `Host` header isn't localhost. Behind a tunnel the Host is the public hostname, so without this the connector's probes 421 before a session opens. `*` disables the check (fine here — the server is deliberately public behind the tunnel; the protection only matters for localhost-only servers). On Fly, pin it to your stable hostname instead of `*`.

**Use cloudflared, not ngrok.** ngrok-free wraps every response in a browser-interstitial/sign-in page. claude.ai probes `/.well-known/oauth-*` during "Add" to discover auth; ngrok's HTML page intercepts those probes → registration fails ("couldn't register with … Ngrok's sign-in service"). cloudflared quick tunnels have no interstitial → the probes 404 cleanly → claude.ai proceeds authless.

The **connector→server hop is unauthenticated** (the claude.ai dialog offers only OAuth, no static-bearer field); prototype security = the unguessable tunnel URL. Anyone who learns the URL can read/write your graph — fine for a private prototype, not for anything public. Real auth later = OAuth, or a stable named tunnel / Fly deploy.

## 2. Add at claude.ai

Settings → Connectors → **Add custom connector**:
- **Name:** `Gooni Focus`
- **Remote MCP server URL:** `https://<random>.trycloudflare.com/mcp`  ← keep the `/mcp` suffix
- OAuth fields: leave blank → **Add**

`trycloudflare` URLs rotate on restart — re-add when the URL changes (and delete the stale connector). A named tunnel or Fly gives a stable URL.

### Also usable from Claude Code

Claude Code is just another MCP client — point it at the LOCAL server (no tunnel needed, same machine):
```bash
claude mcp add --transport http gooni-focus http://localhost:8001/mcp
```
Loads at session start, so it's live the next Claude Code session. Two surfaces (claude.ai chat + Claude Code) feed the one graph.

## 3. Auto-logging — talk, don't command

You don't want to say "log a thought." Make a **Project** on claude.ai (e.g. "Gooni"), enable the Gooni Focus connector in it, and paste this into the project's custom instructions:

> You have a Gooni Focus connector. As we talk, capture my life into it **silently** — don't announce tool calls or ask permission.
>
> - When I share a thought, idea, decision, realization, or observation worth remembering, call **log_thought** with a fitting `topic`. Reuse an existing topic from **list_topics** when one fits; otherwise a new name auto-creates. Group a continuous train of thought under one topic.
> - When I mention a future obligation ("I need to…", "remind me…", "don't let me forget…") call **set_reminder**. If I owe it to a person, pass `owed_to` with their name (that makes it a promise).
> - When I ask what I've been thinking about / what's on my plate / what I owe, use **list_topics**, **query_thoughts**, or **list_reminders** to answer from my actual history.
> - Don't log throwaway chatter, questions to you, or things I'm clearly just asking about. Capture what I'd want to find later.

Then just chat in that Project. Claude reads these instructions + the tool descriptions and logs on its own.

**Caveats:** it's model judgment, not deterministic — it'll occasionally over- or under-log; tune the instructions over time. Every auto-log is a tool round-trip (grows context, spends usage). Watch `/focus` (the kiosk dashboard) or the DB to see what's landing and adjust.

## 4. Verify (the step-3 milestone)

In a project chat: *"connector test — I'm thinking the notch shape should be narrower."* Claude should silently call `log_thought` (topic ≈ "gooni" or "focus system"). Confirm it landed:

```bash
curl -s -H "Authorization: Bearer $(python -c 'from app.common import _expected_token; print(_expected_token())')" \
  http://localhost:8000/focus/dashboard | python -m json.tool
```

...or just open `http://localhost:5173/focus` and watch the circle for that topic grow.
