#!/usr/bin/env python3
"""Daily 24 Hour Fitness -> Gooni exercise sync.

If Daniel checked into a 24hr Fitness club on a given day, mark that day's
`exercise` trackable cell = "gym" in Gooni. Never clobbers: if the cell is
already filled (e.g. a manual "push"/"legs" label), it's left untouched.

Shape:
  1. Log in to 24hr Fitness (POST /account/users/login, captchaToken=null --
     their backend doesn't verify it) -> short-lived JWT.
  2. Pull the day's club visits (GET .../visits) -- read-only.
  3. If >=1 visit AND Gooni's exercise cell is empty -> PUT /metrics/cell.

Idempotent + safe to run repeatedly (a filled cell short-circuits step 3).

Stdlib-only at runtime: no venv required, so a cron/launchd job can call the
system `python3`. (python-dotenv is used if importable; otherwise a tiny
built-in parser reads the repo `.env`.)

Env (loaded from the repo-root .env, cwd-independent):
  TFHF_USERNAME        24hr Fitness login email        (required)
  TFHF_PASSWORD        24hr Fitness password           (required)
  GOONI_API_BASE       Gooni backend base URL          (default https://gooni-bot.fly.dev)
  GOONI_AUTH_PASSWORD  AUTH_PASSWORD of the *target* backend; bearer = sha256(pw).
                       Falls back to AUTH_PASSWORD. (prod uses a different pw than
                       local .env -- set this to the prod password for the cron.)
  GOONI_API_TOKEN      Raw bearer token; overrides the sha256 derivation if set.
  TFHF_TZ              IANA tz for "today" + the visit window (default America/Los_Angeles)

Flags:
  --date YYYY-MM-DD    sync a specific day instead of today
  --label TEXT         label to write (default "gym")
  --dry-run            do everything except the final write
  -v/--verbose         debug logging

Exit 0 = wrote or nothing-to-do; non-zero = error (surfaces in the cron log).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TFHF_BASE = "https://api.24hourfitness.com"
DEFAULT_GOONI_BASE = "https://gooni-bot.fly.dev"
DEFAULT_TZ = "America/Los_Angeles"
UA = "gooni-fitness-sync/1.0"

log = logging.getLogger("tfhf-sync")


# --- env loading (cwd-independent, stdlib fallback) -------------------------

def _load_env() -> None:
    """Load the repo-root `.env` regardless of the process cwd (a cron job runs
    from `/`). Existing env vars always win (so a launchd `EnvironmentVariables`
    override beats the file)."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    try:
        from dotenv import load_dotenv  # optional dep -- present in the venv
        load_dotenv(env_path)
        return
    except ImportError:
        pass
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


# --- tiny HTTP helper (stdlib only, no new deps) ----------------------------

def _request(method: str, url: str, *, headers: dict, body: dict | None = None):
    """Return (status, response_headers, parsed_json_or_none). Raises on
    transport failure; HTTP >=400 is returned, not raised, so callers can read
    error bodies for diagnostics."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, **headers})
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw, status, rhdrs = resp.read(), resp.status, resp.headers
    except urllib.error.HTTPError as e:
        raw, status, rhdrs = e.read(), e.code, e.headers
    try:
        parsed = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        parsed = None
    return status, rhdrs, parsed


# --- 24hr Fitness -----------------------------------------------------------

_TOKEN_BODY_KEYS = ("securityToken", "security_token", "token", "jwt", "accessToken")


def tfhf_login(username: str, password: str) -> str:
    """POST /account/users/login -> JWT. captchaToken=null: the backend gates
    on format-when-present but skips the check when null (front-end-only
    captcha). Token comes back on the `security-token` response header or in
    the JSON body -- we check both."""
    status, rhdrs, parsed = _request(
        "POST",
        f"{TFHF_BASE}/account/users/login",
        headers={"Content-Type": "application/json"},
        body={"username": username, "password": password, "captchaToken": None},
    )
    if status != 200:
        raise RuntimeError(f"24hr login failed: HTTP {status} {str(parsed)[:200]}")

    for h in ("security-token", "securityToken", "securitytoken"):
        tok = rhdrs.get(h)
        if tok:
            return tok.strip()
    if isinstance(parsed, dict):
        for k in _TOKEN_BODY_KEYS:
            if parsed.get(k):
                return str(parsed[k]).strip()
    raise RuntimeError(
        "24hr login: 200 but no token in headers or body. "
        f"headers={list(rhdrs.keys())} body_keys={list(parsed) if isinstance(parsed, dict) else parsed}"
    )


def tfhf_visited(token: str, username: str, day: date, tz: ZoneInfo) -> int:
    """Return the count of club check-ins for `day`. timezoneOffset is minutes
    from UTC for `day` in `tz` (DST-correct via zoneinfo) -- e.g. -420 in PDT."""
    offset_min = int(datetime(day.year, day.month, day.day, tzinfo=tz).utcoffset().total_seconds() // 60)
    mmddyyyy = day.strftime("%m/%d/%Y")
    q = urllib.parse.urlencode({"startDate": mmddyyyy, "endDate": mmddyyyy, "timezoneOffset": offset_min})
    url = f"{TFHF_BASE}/account/users/{urllib.parse.quote(username, safe='')}/visits?{q}"
    status, _, parsed = _request("GET", url, headers={"securityToken": token})
    if status != 200:
        raise RuntimeError(f"24hr visits failed: HTTP {status} {str(parsed)[:200]}")
    visits = (parsed or {}).get("clubVisits") or []
    for v in visits:
        log.debug("  visit: %s @ %s", v.get("checkinTime"), v.get("clubName"))
    return len(visits)


# --- Gooni ------------------------------------------------------------------

def _bearer() -> str:
    tok = os.getenv("GOONI_API_TOKEN", "").strip()
    if tok:
        return tok
    pw = (os.getenv("GOONI_AUTH_PASSWORD") or os.getenv("AUTH_PASSWORD") or "").strip()
    if not pw:
        raise RuntimeError("no GOONI_API_TOKEN and no GOONI_AUTH_PASSWORD/AUTH_PASSWORD to derive one")
    return hashlib.sha256(pw.encode()).hexdigest()


def gooni_exercise_label(base: str, bearer: str, day: date) -> str | None:
    """The day's exercise label if the cell is filled, else None. Any exercise
    row means filled (set_cell deletes the row when cleared)."""
    iso = day.isoformat()
    url = f"{base.rstrip('/')}/metrics?{urllib.parse.urlencode({'start': iso, 'end': iso})}"
    status, _, parsed = _request("GET", url, headers={"Authorization": f"Bearer {bearer}"})
    if status != 200:
        raise RuntimeError(f"gooni read failed: HTTP {status} {str(parsed)[:200]}")
    for row in parsed or []:
        if row.get("metric_type") == "exercise":
            return row.get("notes") or "(unlabeled)"
    return None


def gooni_set_exercise(base: str, bearer: str, day: date, label: str) -> None:
    url = f"{base.rstrip('/')}/metrics/cell"
    status, _, parsed = _request(
        "PUT", url,
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
        body={"date": day.isoformat(), "metric_type": "exercise", "text": label},
    )
    if status != 200:
        raise RuntimeError(f"gooni write failed: HTTP {status} {str(parsed)[:200]}")


# --- main -------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Sync 24hr Fitness check-ins into Gooni's exercise cell.")
    ap.add_argument("--date", help="YYYY-MM-DD (default: today in TFHF_TZ)")
    ap.add_argument("--label", default="gym", help='label to write (default "gym")')
    ap.add_argument("--dry-run", action="store_true", help="skip the write")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    _load_env()

    tz = ZoneInfo(os.getenv("TFHF_TZ", DEFAULT_TZ))
    day = date.fromisoformat(args.date) if args.date else datetime.now(tz).date()
    base = os.getenv("GOONI_API_BASE", DEFAULT_GOONI_BASE)

    username = (os.getenv("TFHF_USERNAME") or "").strip()
    password = os.getenv("TFHF_PASSWORD") or ""
    if not username or not password:
        log.error("set TFHF_USERNAME and TFHF_PASSWORD in .env")
        return 2

    try:
        token = tfhf_login(username, password)
        count = tfhf_visited(token, username, day, tz)
        log.info("24hr check-ins on %s: %d", day, count)
        if count == 0:
            log.info("no gym visit -> nothing to do")
            return 0

        existing = gooni_exercise_label(base, bearer := _bearer(), day)
        if existing is not None:
            log.info("exercise already set for %s (%r) -> leaving it", day, existing)
            return 0

        if args.dry_run:
            log.info("[dry-run] would set exercise=%r for %s", args.label, day)
            return 0

        gooni_set_exercise(base, bearer, day, args.label)
        log.info("set exercise=%r for %s (%s)", args.label, day, base)
        return 0
    except Exception as e:
        log.error("%s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
