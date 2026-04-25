"""Google Calendar + OAuth client — single-user, no SDK, talks straight to
Google's REST endpoints via httpx. Kept narrow so we don't pull in
google-api-python-client / google-auth just for two API calls.

Setup (one-time, in Google Cloud Console):
  1. Create a project + enable the Google Calendar API.
  2. Configure OAuth consent (External; add yourself as a test user).
  3. Create OAuth 2.0 Client ID (Web application).
  4. Authorized redirect URIs:
       - http://localhost:8000/auth/google/callback        (dev)
       - https://gooni-bot.fly.dev/auth/google/callback    (prod)
  5. Set env vars:
       GOOGLE_CLIENT_ID
       GOOGLE_CLIENT_SECRET
       GOOGLE_REDIRECT_URI   (must match the one you're using)

Scopes requested:
  - calendar.events           (create / read events on primary calendar)
  - calendar.freebusy         (read free/busy — for later 'suggest a slot')
  - userinfo.email            (show which account is connected)
"""

from __future__ import annotations

import os
import time
import urllib.parse
from typing import Any

import httpx
from sqlalchemy.orm import Session

from ..db.models import GoogleOAuthToken


AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CALENDAR_API = "https://www.googleapis.com/calendar/v3"

# Space-separated per Google's spec.
SCOPES = " ".join([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
])


def _env() -> tuple[str | None, str | None, str | None]:
    return (
        os.getenv("GOOGLE_CLIENT_ID"),
        os.getenv("GOOGLE_CLIENT_SECRET"),
        os.getenv("GOOGLE_REDIRECT_URI"),
    )


def is_configured() -> bool:
    client_id, client_secret, redirect_uri = _env()
    return bool(client_id and client_secret and redirect_uri)


def build_authorize_url(state: str = "") -> str:
    """Start the OAuth flow. Returns the URL the user should visit."""
    client_id, _, redirect_uri = _env()
    if not client_id or not redirect_uri:
        raise RuntimeError("Google OAuth env vars not set")
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",        # so we get a refresh_token
        "prompt": "consent",             # force refresh_token on every consent
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(code: str) -> dict[str, Any]:
    client_id, client_secret, redirect_uri = _env()
    if not client_id or not client_secret or not redirect_uri:
        raise RuntimeError("Google OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    """Exchange refresh_token for a new access_token. Google does NOT
    return a new refresh_token on refresh — callers keep the old one.
    """
    client_id, client_secret, _ = _env()
    if not client_id or not client_secret:
        raise RuntimeError("Google OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        data={
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_userinfo(access_token: str) -> dict[str, Any]:
    resp = httpx.get(
        USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ── Token storage + refresh gate ────────────────────────────────────────


def save_tokens_from_exchange(
    db: Session,
    token_response: dict[str, Any],
    account_email: str | None = None,
) -> GoogleOAuthToken:
    """Persist the first-time token exchange result. Creates the row if
    none exists (single-tenant), otherwise updates in place.
    """
    access_token = token_response.get("access_token")
    refresh_token = token_response.get("refresh_token")
    expires_in = int(token_response.get("expires_in", 3600))
    scope = token_response.get("scope") or ""
    if not access_token or not refresh_token:
        raise RuntimeError(f"incomplete token response: keys={list(token_response)}")

    expires_at = int(time.time()) + expires_in - 60  # 60s safety margin

    row = db.query(GoogleOAuthToken).filter(
        GoogleOAuthToken.provider == "google_calendar"
    ).first()
    if row is None:
        row = GoogleOAuthToken(
            provider="google_calendar",
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=expires_at,
            scope=scope,
            account_email=account_email,
        )
        db.add(row)
    else:
        row.access_token = access_token
        row.refresh_token = refresh_token
        row.expires_at = expires_at
        row.scope = scope
        if account_email:
            row.account_email = account_email
    db.commit()
    db.refresh(row)
    return row


def get_valid_access_token(db: Session) -> str | None:
    """Return a valid access token, refreshing if needed. None if the user
    hasn't connected Calendar yet.
    """
    row = db.query(GoogleOAuthToken).filter(
        GoogleOAuthToken.provider == "google_calendar"
    ).first()
    if row is None:
        return None
    now = int(time.time())
    if row.expires_at > now + 30:
        return row.access_token
    # Refresh.
    refreshed = refresh_access_token(row.refresh_token)
    new_access = refreshed.get("access_token")
    new_expires_in = int(refreshed.get("expires_in", 3600))
    if not new_access:
        return None
    row.access_token = new_access
    row.expires_at = now + new_expires_in - 60
    if refreshed.get("scope"):
        row.scope = refreshed["scope"]
    db.commit()
    return row.access_token


def disconnect(db: Session) -> bool:
    """Revoke the token with Google and delete the row."""
    row = db.query(GoogleOAuthToken).filter(
        GoogleOAuthToken.provider == "google_calendar"
    ).first()
    if row is None:
        return False
    # Revoke — best-effort; even if Google refuses, we drop local creds.
    try:
        httpx.post(REVOKE_URL, params={"token": row.refresh_token}, timeout=10)
    except Exception:
        pass
    db.delete(row)
    db.commit()
    return True


def connection_status(db: Session) -> dict[str, Any]:
    configured = is_configured()
    row = db.query(GoogleOAuthToken).filter(
        GoogleOAuthToken.provider == "google_calendar"
    ).first()
    return {
        "configured": configured,
        "connected": row is not None,
        "account_email": row.account_email if row else None,
    }


# ── Calendar API wrappers ───────────────────────────────────────────────


def create_event(
    db: Session,
    summary: str,
    start_iso: str,
    end_iso: str,
    description: str | None = None,
    time_zone: str | None = None,
) -> dict[str, Any]:
    """Create a primary-calendar event. start_iso / end_iso are RFC3339
    with offset, e.g. "2026-05-01T14:00:00-07:00".
    """
    access_token = get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("Calendar not connected")
    body: dict[str, Any] = {
        "summary": summary,
        "start": {"dateTime": start_iso},
        "end": {"dateTime": end_iso},
    }
    if description:
        body["description"] = description
    if time_zone:
        body["start"]["timeZone"] = time_zone
        body["end"]["timeZone"] = time_zone
    resp = httpx.post(
        f"{CALENDAR_API}/calendars/primary/events",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json=body,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def free_busy(
    db: Session,
    time_min_iso: str,
    time_max_iso: str,
    calendars: list[str] | None = None,
) -> dict[str, Any]:
    """Read busy blocks between the given times. Defaults to primary only."""
    access_token = get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("Calendar not connected")
    resp = httpx.post(
        f"{CALENDAR_API}/freeBusy",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={
            "timeMin": time_min_iso,
            "timeMax": time_max_iso,
            "items": [{"id": c} for c in (calendars or ["primary"])],
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()
