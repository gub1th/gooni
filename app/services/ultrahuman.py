"""Ultrahuman ring integration — API key is the PRIMARY path, OAuth secondary.

Verified live 2026-08-16: the Personal API Token (`ULTRAHUMAN_API_KEY`) works
directly against `GET /api/v1/partner/daily_metrics` — the same endpoint the
OAuth flow was built for, no Bearer token needed. Auth header is the bare key,
no "Bearer" prefix: `Authorization: <ULTRAHUMAN_API_KEY>`. The response
nests each metric under `data.metrics.<date>[]`, one `{type, object}` entry
per metric (some flat as `object.value`, some structured like
`object.sleep_score.score`) — see `_parse_daily_metrics` for the exact shape.

The old `/api/v1/metrics` raw-time-series endpoint is gone: `daily_metrics`
already returns everything it did plus the scored rollups.

OAuth 2.0 (added 2026-08-17, docs: https://vision.ultrahuman.com/developer-docs?type=oauth)
stays as a SECONDARY path for accounts without a Personal API Token — same
`daily_metrics` endpoint, Bearer access token instead of the raw key.

Setup (captain to-do, one-time at partner.ultrahuman.com):
  1. API key (preferred): ULTRAHUMAN_API_KEY (+ optional ULTRAHUMAN_EMAIL)
  2. OAuth app, redirect URI:
       - https://gooni-bot.fly.dev/ultrahuman/oauth/callback   (prod)
       - http://localhost:8000/ultrahuman/oauth/callback       (dev)
     Env vars (client id/secret already set on Fly per the launch brief):
       ULTRAHUMAN_CLIENT_ID
       ULTRAHUMAN_CLIENT_SECRET
       ULTRAHUMAN_REDIRECT_URI   (optional — defaults to the prod URL above)

Scope requested (OAuth only): `ring_data` (sleep, recovery, HR, HRV, steps,
temp — per the OAuth docs, this single scope covers every field
`daily_metrics` returns).

Data pulled: sleep score, recovery index, HRV, resting HR, steps, sleep
stages, sleep efficiency, VO2 max, movement index — same "daily rollup"
shape whoop.py produces, so it slots into the same trackable pattern (one
json master + numeric mirrors).
"""

from __future__ import annotations

import os
import secrets
import time
import urllib.parse
from datetime import date as date_cls, datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from ..db.models import OAuthToken


def _local_today(db: Session) -> date_cls:
    from ..common import local_today
    return local_today(db)


# ── OAuth 2.0 (primary path) ────────────────────────────────────────────

AUTHORIZE_URL = "https://auth.ultrahuman.com/authorise"
TOKEN_URL = "https://partner.ultrahuman.com/api/partners/oauth/token"
DAILY_METRICS_URL = "https://partner.ultrahuman.com/api/v1/partner/daily_metrics"

SCOPES = "ring_data"

PROVIDER = "ultrahuman"

_DEFAULT_REDIRECT_URI = "https://gooni-bot.fly.dev/ultrahuman/oauth/callback"


def _oauth_env() -> tuple[str | None, str | None, str]:
    return (
        os.getenv("ULTRAHUMAN_CLIENT_ID"),
        os.getenv("ULTRAHUMAN_CLIENT_SECRET"),
        os.getenv("ULTRAHUMAN_REDIRECT_URI") or _DEFAULT_REDIRECT_URI,
    )


def is_oauth_configured() -> bool:
    cid, secret, redirect = _oauth_env()
    return bool(cid and secret and redirect)


def build_authorize_url(state: str = "") -> str:
    cid, _, redirect = _oauth_env()
    if not cid or not redirect:
        raise RuntimeError("Ultrahuman OAuth env vars not set")
    if not state:
        state = secrets.token_urlsafe(16)
    params = {
        "client_id": cid,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(code: str) -> dict[str, Any]:
    cid, secret, redirect = _oauth_env()
    if not cid or not secret or not redirect:
        raise RuntimeError("Ultrahuman OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": cid,
            "client_secret": secret,
            "redirect_uri": redirect,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    cid, secret, _ = _oauth_env()
    if not cid or not secret:
        raise RuntimeError("Ultrahuman OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        json={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": cid,
            "client_secret": secret,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def save_tokens_from_exchange(
    db: Session,
    token_response: dict[str, Any],
    account_email: str | None = None,
) -> OAuthToken:
    access_token = token_response.get("access_token")
    refresh_token = token_response.get("refresh_token")
    # Ultrahuman access tokens expire in 86400s (1 day) per the launch brief;
    # fall back to that if the response omits expires_in.
    expires_in = int(token_response.get("expires_in", 86400))
    scope = token_response.get("scope") or SCOPES
    if not access_token:
        raise RuntimeError(f"incomplete token response: keys={list(token_response)}")
    expires_at = int(time.time()) + expires_in - 60

    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    if row is None:
        row = OAuthToken(
            provider=PROVIDER,
            access_token=access_token,
            refresh_token=refresh_token or "",
            expires_at=expires_at,
            scope=scope,
            account_email=account_email or os.getenv("ULTRAHUMAN_EMAIL"),
        )
        db.add(row)
    else:
        row.access_token = access_token
        if refresh_token:
            row.refresh_token = refresh_token
        row.expires_at = expires_at
        row.scope = scope
        if account_email:
            row.account_email = account_email
    db.commit()
    db.refresh(row)
    return row


def get_valid_access_token(db: Session) -> str | None:
    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    if row is None:
        return None
    now = int(time.time())
    if row.expires_at > now + 30:
        return row.access_token
    if not row.refresh_token:
        return None
    try:
        refreshed = refresh_access_token(row.refresh_token)
    except Exception:
        return None
    new_access = refreshed.get("access_token")
    if not new_access:
        return None
    row.access_token = new_access
    row.expires_at = now + int(refreshed.get("expires_in", 86400)) - 60
    new_refresh = refreshed.get("refresh_token")
    if new_refresh:
        row.refresh_token = new_refresh
    db.commit()
    return row.access_token


def disconnect(db: Session) -> bool:
    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


# ── API key (primary path) ──────────────────────────────────────────────


def _apikey_env() -> str | None:
    return os.getenv("ULTRAHUMAN_API_KEY")


def is_apikey_configured() -> bool:
    return bool(_apikey_env())


# Kept for callers/tests that only care "is *some* Ultrahuman path usable".
def is_configured() -> bool:
    return is_oauth_configured() or is_apikey_configured()


def connection_status(db: Session) -> dict[str, Any]:
    """Same shape as whoop.connection_status() so the frontend's
    IntegrationSection component works unmodified: `connected` means a live
    OAuth token, not just "an env var is set". `configured` gates whether
    the connect button is clickable at all."""
    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    return {
        "configured": is_oauth_configured(),
        "connected": row is not None,
        "account_email": row.account_email if row else None,
        # Extra fields (not on whoop's shape) — the API-key fallback is its
        # own independent connection and the frontend may want to know it's
        # still live even with no OAuth token.
        "apikey_configured": is_apikey_configured(),
    }


# ── daily_metrics fetch + parse (shared by both auth paths) ────────────
#
# Verified live response shape (2026-08-16):
#   {"data": {"metrics": {"<date>": [{"type": "sleep", "object": {...}}, ...]}}}
# Most types are FLAT (`object.value`), a few are NESTED
# (`sleep_score.object.sleep_score.score`, `total_sleep.object.total_sleep.minutes`, ...).


def _num(v: Any) -> Any:
    return v if isinstance(v, (int, float)) else None


def _parse_daily_metrics(raw: dict[str, Any], day: date_cls) -> dict[str, Any]:
    metrics = ((raw.get("data") or {}).get("metrics") or {})
    entries = metrics.get(day.isoformat()) or []

    by_type: dict[str, Any] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        obj = entry.get("object")
        if kind and isinstance(obj, dict):
            by_type[kind] = obj

    sleep = by_type.get("sleep") or {}

    def flat(kind: str) -> Any:
        return _num((by_type.get(kind) or {}).get("value"))

    sleep_score = _num((sleep.get("sleep_score") or {}).get("score"))
    total_sleep_minutes = _num((sleep.get("total_sleep") or {}).get("minutes"))
    sleep_efficiency = _num((sleep.get("sleep_efficiency") or {}).get("percentage"))
    deep_sleep_minutes = _num((sleep.get("deep_sleep") or {}).get("minutes"))
    light_sleep_minutes = _num((sleep.get("light_sleep") or {}).get("minutes"))
    rem_sleep_minutes = _num((sleep.get("rem_sleep") or {}).get("minutes"))
    restorative_sleep = _num((sleep.get("restorative_sleep") or {}).get("percentage"))

    recovery_index = flat("recovery_index")
    avg_sleep_hrv = flat("avg_sleep_hrv")
    sleep_rhr = flat("sleep_rhr")
    vo2_max = flat("vo2_max")
    movement_index = flat("movement_index")
    active_minutes = flat("active_minutes")
    steps = _num((by_type.get("steps") or {}).get("total"))

    return {
        "sleep_score": sleep_score,
        "sleep_minutes": total_sleep_minutes,
        "total_sleep_minutes": total_sleep_minutes,
        "sleep_efficiency": sleep_efficiency,
        "deep_sleep_minutes": deep_sleep_minutes,
        "light_sleep_minutes": light_sleep_minutes,
        "rem_sleep_minutes": rem_sleep_minutes,
        "restorative_sleep": restorative_sleep,
        "recovery_score": recovery_index,
        "recovery_index": recovery_index,
        "hrv_ms": avg_sleep_hrv,
        "avg_sleep_hrv": avg_sleep_hrv,
        "resting_hr": sleep_rhr,
        "sleep_rhr": sleep_rhr,
        "steps": steps,
        "active_minutes": active_minutes,
        "movement_index": movement_index,
        "vo2_max": vo2_max,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _fetch_daily_metrics(db: Session, headers: dict[str, str]) -> dict[str, Any]:
    today = _local_today(db)
    params: dict[str, Any] = {"date": today.isoformat()}
    resp = httpx.get(DAILY_METRICS_URL, headers=headers, params=params, timeout=20)
    resp.raise_for_status()
    return _parse_daily_metrics(resp.json(), today)


def _fetch_via_apikey(db: Session) -> dict[str, Any]:
    api_key = _apikey_env()
    if not api_key:
        raise RuntimeError("Ultrahuman not configured (ULTRAHUMAN_API_KEY missing)")
    return _fetch_daily_metrics(db, {"Authorization": api_key})


def _fetch_via_oauth(db: Session, access_token: str) -> dict[str, Any]:
    return _fetch_daily_metrics(db, {"Authorization": f"Bearer {access_token}"})


def fetch_today_snapshot(db: Session) -> dict[str, Any] | None:
    """API key first (the verified, no-OAuth-needed path); falls back to
    OAuth when no API key is configured. Returns None if neither is
    configured."""
    if is_apikey_configured():
        return _fetch_via_apikey(db)
    token = get_valid_access_token(db)
    if token:
        return _fetch_via_oauth(db, token)
    return None


# ── Trackable feed (mirrors whoop.py's pattern exactly) ────────────────

MASTER_KEY = "ultrahuman"
_NUMERIC_KEYS: tuple[tuple[str, str, str | None], ...] = (
    # (trackable name, payload key, unit)
    ("ultrahuman sleep score", "sleep_score", "%"),
    ("ultrahuman total sleep", "total_sleep_minutes", "min"),
    ("ultrahuman deep sleep", "deep_sleep_minutes", "min"),
    ("ultrahuman rem sleep", "rem_sleep_minutes", "min"),
    ("ultrahuman sleep efficiency", "sleep_efficiency", "%"),
    ("ultrahuman recovery", "recovery_index", "%"),
    ("ultrahuman hrv", "avg_sleep_hrv", "ms"),
    ("ultrahuman rhr", "sleep_rhr", "bpm"),
    ("ultrahuman steps", "steps", None),
    ("ultrahuman vo2 max", "vo2_max", None),
)


def upsert_today_snapshot(db: Session, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Persist today's Ultrahuman data as Trackable entries — replace-mode
    per local day, same as whoop.upsert_today_snapshot."""
    from . import trackable_service

    today = _local_today(db)
    doc = dict(payload)
    doc["updated_at"] = datetime.utcnow().isoformat()

    master = trackable_service.create(
        db, name=MASTER_KEY, kind="json", agg="last", source="ultrahuman",
        schema_hint={"description": "daily ultrahuman rollup: sleep/recovery/activity"},
    )
    trackable_service.log_entry(
        db, master, day=today, value_json=doc, source="ultrahuman", replace=True,
    )

    for name, key, unit in _NUMERIC_KEYS:
        val = doc.get(key)
        if val is None:
            continue
        t = trackable_service.create(
            db, name=name, kind="numeric", unit=unit, agg="last", source="ultrahuman",
        )
        trackable_service.log_entry(
            db, t, day=today, value_numeric=float(val), source="ultrahuman", replace=True,
        )

    return doc


def get_today(db: Session) -> dict[str, Any] | None:
    """Today's cached payload from the master trackable, or None."""
    from . import trackable_service

    t = trackable_service.get_by_name(db, MASTER_KEY)
    if t is None:
        return None
    today = _local_today(db)
    entries = trackable_service.entries_for(db, t, start=today, end=today)
    val = trackable_service.day_value(entries, t)
    return val if isinstance(val, dict) else None
