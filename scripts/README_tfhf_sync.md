# 24hr Fitness → Gooni exercise sync

Personal interop (own account, own data): if Daniel checked into a 24 Hour
Fitness club on a given day, mark that day's `exercise` cell = `gym` in Gooni.
Never clobbers a manually-set label (`push`/`legs`/…) — a filled cell is left
alone. Idempotent; safe to re-run.

## Where it runs

**Server-side, in-process, on Fly** — not a Mac cron. It's one of the
integrations refreshed by the hourly `_integration_refresh_loop` in
`app/background.py` (the same background-loop pattern as the excerpt backfill
+ memory watchdog), alongside whoop and leetcode. Runs every
`INTEGRATION_REFRESH_INTERVAL_S` (default 1h), so the log fills even on days
the app is never opened. No external cron infra — this IS the cron.

Logic lives in `app/services/fitness_24hr.py`; `scripts/sync_24hr_fitness.py`
is just a manual/debug CLI over the same `sync_today`.

## How it works

1. `POST api.24hourfitness.com/account/users/login` with `captchaToken: null`
   → short-lived JWT (their backend only format-checks the captcha token when
   present, so `null` skips it — front-end-only gate).
2. `GET .../users/{email}/visits?startDate=&endDate=&timezoneOffset=` with
   header `securityToken: <jwt>` → the day's `clubVisits`.
3. If ≥1 visit **and** the exercise cell is empty →
   `daily_metric_service.set_cell(db, day, "exercise", 1.0, notes="gym")`.

## Setup (prod)

Set the two secrets on Fly (app `gooni-bot`); the loop reads them from the
process env:

```bash
fly secrets set \
  TFHF_USERNAME="danielfgunawan1@gmail.com" \
  TFHF_PASSWORD="<24hr fitness password>" \
  --app gooni-bot
```

`fly secrets set` triggers a rolling restart to inject them. That's all — no
`GOONI_AUTH_PASSWORD`/bearer needed (it writes the DB in-process, not over
HTTP). whoop/leetcode creds are already configured.

## Local debug

Put the creds in the repo `.env` (gitignored), then:

```bash
python scripts/sync_24hr_fitness.py --dry-run -v      # today, no write
python scripts/sync_24hr_fitness.py --date 2026-07-16 # backfill a day
```

Missing creds → the sync returns `{"skipped": "no TFHF creds"}` and the loop
moves on (never crashes boot).

## Notes

- JWT lives ~20 min; the sync logs in fresh each run, nothing to cache.
- Hourly is intentional — a gym check-in happens ~once/day, and once the cell
  is filled the remaining runs that day are no-op reads (no clobber). Change
  the cadence via `INTEGRATION_REFRESH_INTERVAL_S`.
- The 24hr JWT is HS256, issuer `urn://apigee-edge-JWT-policy-test` — can't be
  forged (server holds the secret), so we always go through real login. Legit,
  read-only, low-volume.
