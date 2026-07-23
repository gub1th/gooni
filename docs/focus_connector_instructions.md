# Focus system — connector setup + auto-logging

How to wire the `mcp/focus_server.py` connector into claude.ai so you log to Gooni just by talking — no "log a thought" incantation.

## 1. Run the server + tunnel

```bash
# Backend already running on :8000. Then:
cd <repo>
export $(grep -E '^(AUTH_PASSWORD|GOONI_URL)=' .env | xargs)
GOONI_URL="${GOONI_URL:-http://localhost:8000}" \
GOONI_AUTH_PASSWORD="$AUTH_PASSWORD" \
FOCUS_MCP_PORT=8001 \
python mcp/focus_server.py            # → http://127.0.0.1:8001/mcp

# In another tab, expose it:
ngrok http 8001                       # or: cloudflared tunnel --url http://localhost:8001
```

`GOONI_AUTH_PASSWORD="$AUTH_PASSWORD"` is the load-bearing line — it makes the server's Bearer token match the gated backend. The **connector→server hop is unauthenticated** (the claude.ai dialog offers only OAuth, no static-bearer field); prototype security = the unguessable tunnel URL. Anyone who learns the URL can read/write your graph — fine for a private prototype, not for anything public. Real auth later = OAuth, or a stable named tunnel / Fly deploy.

## 2. Add at claude.ai

Settings → Connectors → **Add custom connector**:
- **Name:** `Gooni Focus`
- **Remote MCP server URL:** `https://<tunnel>/mcp`  ← keep the `/mcp` suffix
- OAuth fields: leave blank → **Add**

`trycloudflare`/`ngrok-free` URLs rotate on restart — re-add when the URL changes. A named tunnel or Fly gives a stable URL.

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
