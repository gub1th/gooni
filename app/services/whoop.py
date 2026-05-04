"""Whoop integration — single-user OAuth 2.0 + thin REST client. Mirrors
the shape of `google_calendar.py` (no SDK, just httpx) so the connect /
status / disconnect machinery in main.py reads the same way for both.

Setup (one-time, at developer.whoop.com):
  1. Create a Whoop OAuth client.
  2. Set redirect URI:
       - http://localhost:8000/auth/whoop/callback        (dev)
       - https://gooni-bot.fly.dev/auth/whoop/callback    (prod)
  3. Set env vars:
       WHOOP_CLIENT_ID
       WHOOP_CLIENT_SECRET
       WHOOP_REDIRECT_URI

Scopes requested:
  - read:recovery        (recovery score, HRV, RHR)
  - read:cycle           (daily strain)
  - read:sleep           (sleep totals + quality)
  - read:profile         (account display)
"""

from __future__ import annotations

import os
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from ..db.models import OAuthToken, WhoopSnapshot


AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API_BASE = "https://api.prod.whoop.com/developer"

SCOPES = " ".join([
    "read:recovery",
    "read:cycles",
    "read:sleep",
    "read:profile",
    "offline",  # requests a refresh_token
])

PROVIDER = "whoop"


def _env() -> tuple[str | None, str | None, str | None]:
    return (
        os.getenv("WHOOP_CLIENT_ID"),
        os.getenv("WHOOP_CLIENT_SECRET"),
        os.getenv("WHOOP_REDIRECT_URI"),
    )


def is_configured() -> bool:
    cid, secret, redirect = _env()
    return bool(cid and secret and redirect)


def build_authorize_url(state: str = "") -> str:
    cid, _, redirect = _env()
    if not cid or not redirect:
        raise RuntimeError("Whoop OAuth env vars not set")
    params = {
        "client_id": cid,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(code: str) -> dict[str, Any]:
    cid, secret, redirect = _env()
    if not cid or not secret or not redirect:
        raise RuntimeError("Whoop OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
            "client_id": cid,
            "client_secret": secret,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    cid, secret, _ = _env()
    if not cid or not secret:
        raise RuntimeError("Whoop OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": cid,
            "client_secret": secret,
            "scope": SCOPES,
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
    expires_in = int(token_response.get("expires_in", 3600))
    scope = token_response.get("scope") or ""
    if not access_token:
        raise RuntimeError(f"incomplete token response: keys={list(token_response)}")
    # Whoop returns refresh_token only when `offline` scope is requested. If
    # missing, keep whatever we already had (refresh-then-keep behavior).
    expires_at = int(time.time()) + expires_in - 60

    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    if row is None:
        row = OAuthToken(
            provider=PROVIDER,
            access_token=access_token,
            refresh_token=refresh_token or "",
            expires_at=expires_at,
            scope=scope,
            account_email=account_email,
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
    row.expires_at = now + int(refreshed.get("expires_in", 3600)) - 60
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


def connection_status(db: Session) -> dict[str, Any]:
    configured = is_configured()
    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    return {
        "configured": configured,
        "connected": row is not None,
        "account_email": row.account_email if row else None,
    }


# ── Profile + data fetchers ─────────────────────────────────────────────


def fetch_profile(access_token: str) -> dict[str, Any]:
    resp = httpx.get(
        f"{API_BASE}/v1/user/profile/basic",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def _get(access_token: str, path: str, params: dict | None = None) -> dict[str, Any]:
    resp = httpx.get(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params or {},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_today_snapshot(db: Session) -> dict[str, Any] | None:
    """Pull the most recent recovery + cycle + sleep records and roll them
    into a single dict shape suitable for caching and surfacing on the
    dashboard. Returns None if the user isn't connected.
    """
    token = get_valid_access_token(db)
    if not token:
        return None

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=2)
    params = {"start": start.isoformat(), "end": end.isoformat(), "limit": 5}

    recovery_records = _get(token, "/v1/recovery", params).get("records", [])
    cycle_records = _get(token, "/v1/cycle", params).get("records", [])
    sleep_records = _get(token, "/v1/activity/sleep", params).get("records", [])

    # Pick the freshest of each. Whoop returns newest first by default,
    # but sort defensively by created_at so this isn't a silent contract.
    def _newest(records: list[dict], key: str = "created_at") -> dict | None:
        if not records:
            return None
        return sorted(records, key=lambda r: r.get(key) or "", reverse=True)[0]

    recovery = _newest(recovery_records) or {}
    cycle = _newest(cycle_records) or {}
    sleep = _newest(sleep_records) or {}

    rec_score = (recovery.get("score") or {})
    cyc_score = (cycle.get("score") or {})
    slp_score = (sleep.get("score") or {})
    slp_stage = (slp_score.get("stage_summary") or {})

    return {
        "recovery_score": rec_score.get("recovery_score"),
        "hrv_rmssd_ms": rec_score.get("hrv_rmssd_milli"),
        "resting_hr": rec_score.get("resting_heart_rate"),
        "strain": cyc_score.get("strain"),
        "sleep_minutes": (
            int((slp_stage.get("total_in_bed_time_milli") or 0) / 60000)
            if slp_stage else None
        ),
        "sleep_performance_pct": slp_score.get("sleep_performance_percentage"),
        "fetched_at": end.isoformat(),
    }


def upsert_today_snapshot(db: Session, payload: dict[str, Any]) -> WhoopSnapshot | None:
    """Save a snapshot row for today. Idempotent on (date) — re-running
    overwrites the same day's row rather than stacking duplicates.
    """
    today = datetime.now(timezone.utc).date()
    row = db.query(WhoopSnapshot).filter(WhoopSnapshot.date == today).first()
    if row is None:
        row = WhoopSnapshot(date=today)
        db.add(row)
    row.recovery_score = payload.get("recovery_score")
    row.hrv_rmssd_ms = payload.get("hrv_rmssd_ms")
    row.resting_hr = payload.get("resting_hr")
    row.strain = payload.get("strain")
    row.sleep_minutes = payload.get("sleep_minutes")
    row.sleep_performance_pct = payload.get("sleep_performance_pct")
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row
