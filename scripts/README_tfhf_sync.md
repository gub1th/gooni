# 24hr Fitness → Gooni exercise sync

Personal interop (own account, own data): if Daniel checked into a 24 Hour
Fitness club on a given day, mark that day's `exercise` cell = `gym` in Gooni.
Never clobbers a manually-set label (`push`/`legs`/…) — a filled cell is left
alone. Idempotent; safe to re-run.

## How it works

1. `POST api.24hourfitness.com/account/users/login` with `captchaToken: null`
   → short-lived JWT (their backend only format-checks the captcha token when
   present, so `null` skips it — front-end-only gate).
2. `GET .../users/{email}/visits?startDate=&endDate=&timezoneOffset=` with
   header `securityToken: <jwt>` → the day's `clubVisits`.
3. If ≥1 visit **and** Gooni's exercise cell is empty →
   `PUT /metrics/cell {date, metric_type:"exercise", text:"gym"}`.

Stdlib-only at runtime — no venv needed (system `python3` works).

## Setup

1. Put the secrets in the repo `.env` (gitignored):

   ```
   TFHF_USERNAME=danielfgunawan1@gmail.com
   TFHF_PASSWORD=<24hr fitness password>
   # cron target = prod, which uses a different AUTH_PASSWORD than local:
   GOONI_AUTH_PASSWORD=<prod backend AUTH_PASSWORD>
   ```

   (Local dev override: `GOONI_API_BASE=http://localhost:8000` + the local
   `AUTH_PASSWORD` already in `.env`.)

2. Test it (no write):

   ```bash
   python3 scripts/sync_24hr_fitness.py --dry-run -v
   ```

3. Schedule it (macOS launchd, runs 23:55 local):

   ```bash
   cp scripts/com.gooni.tfhf-sync.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.gooni.tfhf-sync.plist
   launchctl start com.gooni.tfhf-sync   # run once now to verify
   tail -f /tmp/gooni-tfhf-sync.log
   ```

   Alternative (always-on host): run the same script from any daily cron that
   can reach the prod backend — it's self-contained.

## Flags

| flag | meaning |
|------|---------|
| `--date YYYY-MM-DD` | sync a specific day (default: today in `TFHF_TZ`) |
| `--label TEXT` | label to write (default `gym`) |
| `--dry-run` | do everything except the final write |
| `-v` | debug logging (prints each check-in) |

## Notes

- JWT lives ~20 min (`exp - iat = 1200s`); the script logs in fresh each run,
  so nothing to cache.
- The 24hr JWT is HS256, issuer `urn://apigee-edge-JWT-policy-test` — can't be
  forged (server holds the secret), so we always go through real login. Legit,
  read-only, low-volume.
