"""Ultrahuman ring integration — TWO auth paths, kept side by side.

**OAuth 2.0** (added 2026-08-17) is now the primary path — mirrors
`whoop.py`'s shape exactly (OAuthToken row, auto-refresh, json master +
numeric-mirror Trackable feed) — because the real per-metric data
(`sleep_score`, `recovery_index`, HRV, steps, ...) lives behind
`GET /api/v1/partner/daily_metrics`, which requires a Bearer access token
from the 3-legged Partner OAuth flow (docs:
https://vision.ultrahuman.com/developer-docs?type=oauth). The old API-key
`/api/v1/metrics` endpoint returns only raw HR/temp/HRV time-series, not
the scored daily rollups — kept below as a FALLBACK when no OAuth token is
connected, not removed.

Setup (captain to-do, one-time at partner.ultrahuman.com):
  1. Register an OAuth app, redirect URI:
       - https://gooni-bot.fly.dev/ultrahuman/oauth/callback   (prod)
       - http://localhost:8000/ultrahuman/oauth/callback       (dev)
  2. Env vars (client id/secret already set on Fly per the launch brief):
       ULTRAHUMAN_CLIENT_ID
       ULTRAHUMAN_CLIENT_SECRET
       ULTRAHUMAN_REDIRECT_URI   (optional — defaults to the prod URL above)
  3. API-key fallback (unchanged, still supported):
       ULTRAHUMAN_API_KEY
       ULTRAHUMAN_EMAIL

Scope requested: `ring_data` (sleep, recovery, HR, HRV, steps, temp — per
the OAuth docs, this single scope covers every field `daily_metrics`
returns).

Data pulled: sleep score, recovery index, HRV, resting HR, steps, temp,
SpO2, VO2 max — same "daily rollup" shape whoop.py produces, so it slots
into the same trackable pattern (one json master + numeric mirrors).
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

AUTHORIZE_URL = "https://partner.ultrahuman.com/authorize"
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


# ── API-key fallback (unchanged path — kept for /api/v1/metrics) ───────


def _apikey_env() -> tuple[str | None, str | None]:
    return (
        os.getenv("ULTRAHUMAN_API_KEY"),
        os.getenv("ULTRAHUMAN_EMAIL"),
    )


def is_apikey_configured() -> bool:
    api_key, email = _apikey_env()
    return bool(api_key and email)


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


_API_BASE = "https://partner.ultrahuman.com/api/v1"


def _apikey_headers() -> dict[str, str]:
    api_key, _ = _apikey_env()
    if not api_key:
        raise RuntimeError("Ultrahuman not configured (ULTRAHUMAN_API_KEY missing)")
    return {"Authorization": api_key}


def _apikey_get(path: str, params: dict | None = None) -> dict[str, Any]:
    resp = httpx.get(
        f"{_API_BASE}{path}",
        headers=_apikey_headers(),
        params=params or {},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def _fetch_via_apikey(db: Session) -> dict[str, Any]:
    """Best-guess parse of the raw-metrics endpoint — the original stub's
    logic, unverified but left as a fallback only reached when there's no
    OAuth connection."""
    _, email = _apikey_env()
    today = _local_today(db)
    data = _apikey_get("/metrics", params={"email": email, "date": today.isoformat()})
    sleep = data.get("sleep") or {}
    recovery = data.get("recovery") or {}
    activity = data.get("activity") or {}
    return {
        "sleep_score": sleep.get("score"),
        "sleep_minutes": sleep.get("duration_minutes"),
        "recovery_score": recovery.get("score") or recovery.get("recovery_index"),
        "recovery_index": recovery.get("recovery_index") or recovery.get("score"),
        "hrv_ms": recovery.get("hrv") or recovery.get("hrv_ms"),
        "resting_hr": recovery.get("resting_heart_rate"),
        "steps": activity.get("steps"),
        "active_calories": activity.get("active_calories"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


# ── OAuth daily-metrics fetch (the real, per-metric data) ──────────────


def _unwrap(raw: dict[str, Any]) -> dict[str, Any]:
    """`daily_metrics` may envelope the payload under a wrapper key —
    unconfirmed against a live account, so this tries the obvious ones
    before falling back to the raw dict itself. TODO(captain): drop this
    once you've seen a real response."""
    for key in ("data", "result", "metrics"):
        inner = raw.get(key)
        if isinstance(inner, dict):
            return inner
    return raw


def _fetch_via_oauth(db: Session, access_token: str) -> dict[str, Any]:
    today = _local_today(db)
    params: dict[str, Any] = {"date": today.isoformat()}
    email = os.getenv("ULTRAHUMAN_EMAIL")
    if email:
        params["email"] = email
    resp = httpx.get(
        DAILY_METRICS_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=20,
    )
    resp.raise_for_status()
    d = _unwrap(resp.json())

    recovery_index = d.get("recovery_index")
    if recovery_index is None:
        recovery_index = d.get("recovery")
    hrv_ms = d.get("hrv")
    if hrv_ms is None:
        hrv_ms = d.get("avg_sleep_hrv")
    resting_hr = d.get("night_rhr")
    if resting_hr is None:
        resting_hr = d.get("sleep_rhr") or d.get("hr")

    return {
        "sleep_score": d.get("sleep_score"),
        "sleep_minutes": d.get("total_sleep"),
        "sleep_efficiency": d.get("sleep_efficiency"),
        "deep_sleep_minutes": d.get("deep_sleep"),
        "light_sleep_minutes": d.get("light_sleep"),
        "rem_sleep_minutes": d.get("rem_sleep"),
        "recovery_score": recovery_index,
        "recovery_index": recovery_index,
        "hrv_ms": hrv_ms,
        "avg_sleep_hrv": d.get("avg_sleep_hrv"),
        "resting_hr": resting_hr,
        "steps": d.get("steps"),
        "active_minutes": d.get("active_minutes"),
        "movement_index": d.get("movement_index"),
        "temp": d.get("temp"),
        "spo2": d.get("spo2"),
        "vo2_max": d.get("vo2_max"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def fetch_today_snapshot(db: Session) -> dict[str, Any] | None:
    """OAuth first (the real per-metric data); falls back to the API-key
    raw-metrics endpoint when no OAuth token is connected. Returns None if
    neither path is configured."""
    token = get_valid_access_token(db)
    if token:
        return _fetch_via_oauth(db, token)
    if is_apikey_configured():
        return _fetch_via_apikey(db)
    return None


# ── Trackable feed (mirrors whoop.py's pattern exactly) ────────────────

MASTER_KEY = "ultrahuman"
_NUMERIC_KEYS: tuple[tuple[str, str, str | None], ...] = (
    # (trackable name, payload key, unit)
    ("ultrahuman sleep score", "sleep_score", "%"),
    ("ultrahuman recovery", "recovery_index", "%"),
    ("ultrahuman hrv", "hrv_ms", "ms"),
    ("ultrahuman rhr", "resting_hr", "bpm"),
    ("ultrahuman steps", "steps", None),
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
