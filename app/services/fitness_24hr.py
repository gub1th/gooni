"""24 Hour Fitness -> exercise trackable sync (personal interop).

Logs into 24hourfitness.com (captchaToken=null -- their backend only
format-checks the captcha token when present, so null skips it), reads the
day's club check-ins, and if there's a visit AND Gooni's `exercise` cell for
that day is empty, writes exercise="gym". Idempotent + never clobbers a manual
push/legs label (a filled cell short-circuits the write).

Runs server-side from the hourly integration-refresh loop
(`app/background.py`); also callable from `scripts/sync_24hr_fitness.py` for
manual/debug runs. Creds from env: TFHF_USERNAME / TFHF_PASSWORD (fly secrets
in prod, .env locally). Missing creds -> skip, never raise. Stdlib-only HTTP
(no new deps).
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

from sqlalchemy.orm import Session

from ..common import local_now, local_today

log = logging.getLogger("fitness_24hr")

TFHF_BASE = "https://api.24hourfitness.com"
UA = "gooni-fitness-sync/1.0"
_TOKEN_BODY_KEYS = ("securityToken", "security_token", "token", "jwt", "accessToken")


def _request(method: str, url: str, *, headers: dict, body: dict | None = None):
    """(status, response_headers, parsed_json). HTTP >=400 is returned, not
    raised, so callers can read error bodies."""
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


def login(username: str, password: str) -> str:
    """POST /account/users/login -> short-lived JWT (on the `security-token`
    response header or in the body)."""
    status, rhdrs, parsed = _request(
        "POST", f"{TFHF_BASE}/account/users/login",
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
        f"24hr login: 200 but no token. headers={list(rhdrs.keys())}"
    )


def visits_count(token: str, username: str, day: date, offset_min: int) -> int:
    """Club check-in count for `day`. `offset_min` = minutes from UTC for that
    day in the user's tz (DST-correct)."""
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


def _exercise_label(db: Session, day: date) -> str | None:
    """The day's exercise label if the cell is filled, else None (set_cell
    deletes the row when cleared, so any row = filled)."""
    from . import daily_metric_service
    for row in daily_metric_service.list_entries(db, day, day):
        if row.get("metric_type") == "exercise":
            return row.get("notes") or "(unlabeled)"
    return None


def sync_today(db: Session, day: date | None = None, label: str = "gym", dry_run: bool = False) -> dict:
    """Sync one day (default: local today). Writes exercise=`label` only if
    there's a check-in AND the cell is empty. Returns a status dict; a missing
    cred / no-visit is a normal skip (no raise). Network / auth failures raise
    so the caller's guard can log them."""
    username = (os.getenv("TFHF_USERNAME") or "").strip()
    password = os.getenv("TFHF_PASSWORD") or ""
    if not username or not password:
        return {"skipped": "no TFHF creds"}

    day = day or local_today(db)
    tz = local_now(db).tzinfo
    offset_min = int(datetime(day.year, day.month, day.day, tzinfo=tz).utcoffset().total_seconds() // 60)

    token = login(username, password)
    count = visits_count(token, username, day, offset_min)
    if count == 0:
        return {"day": day.isoformat(), "visits": 0, "wrote": False}

    existing = _exercise_label(db, day)
    if existing is not None:
        return {"day": day.isoformat(), "visits": count, "wrote": False, "existing": existing}

    if dry_run:
        return {"day": day.isoformat(), "visits": count, "wrote": False, "dry_run": True}

    from . import daily_metric_service
    daily_metric_service.set_cell(db, day, "exercise", value=1.0, notes=label)  # commits internally
    return {"day": day.isoformat(), "visits": count, "wrote": True, "label": label}
