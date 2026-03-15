# Fly.io Deployment Debug Guide

## Quick Status Check

```bash
# Is the app running?
fly status

# Current machine memory/CPU
fly machine list
```

## Logs

```bash
# Stream live logs (most useful for debugging)
fly logs --tail

# Last N lines of logs
fly logs

# Filter for specific keywords
fly logs | grep -i "telegram\|error\|oom\|killed"

# Save logs to file
fly logs > debug.log
```

## What to look for in logs

| Pattern | Meaning |
|---|---|
| `Out of memory: Killed process` | OOM kill — machine ran out of memory |
| `Process appears to have been OOM killed` | Fly detected OOM kill |
| `Starting Gooni Telegram Bot` | Bot started successfully |
| `Uvicorn running on http://0.0.0.0:8080` | FastAPI started |
| `Error` / `Traceback` | Python exception |

## SSH into the machine

```bash
# Open a shell (uses /bin/sh, not bash)
fly ssh console

# Run a single command
fly ssh console -C "/bin/sh -c 'cat /proc/1/cmdline | tr \"\0\" \" \"'"
```

> Note: the container is minimal — no `ps`, no `bash`. Use `/bin/sh` and `/proc`.

## Deploy

```bash
# Deploy latest code
fly deploy

# Deploy and watch logs in real time
fly deploy && fly logs --tail
```

## Secrets (environment variables)

```bash
# List secret names (values are hidden)
fly secrets list

# Set a secret
fly secrets set MY_SECRET=value

# Remove a secret
fly secrets unset MY_SECRET
```

## Memory / VM config

Defined in `fly.toml`:
```toml
[[vm]]
  memory = '512mb'
  cpu_kind = 'shared'
  cpus = 1
```

To change: edit `fly.toml` then `fly deploy`.

## Telegram bot not responding checklist

1. `fly status` — is the machine running?
2. `fly logs` — any OOM kills or Python errors?
3. `fly secrets list` — is `TELEGRAM_BOT_TOKEN` set?
4. Make sure local `scripts/telegram_bot.py` is **not** running — two pollers = conflict
5. Check `start.sh` — does it launch the bot process?

## Common issues

**OOM kill** — Bot process dies silently, only FastAPI survives. Fix: bump `memory` in `fly.toml`.

**Two pollers** — Local dev also running `telegram_bot.py`. Only one poller can receive messages. Fix: don't run the bot locally when Fly is active.

**Stale deploy** — Rolling deploy kills old machine (you'll see OOM in logs from the dying machine, not the new one). Normal — check logs *after* the new machine starts.
