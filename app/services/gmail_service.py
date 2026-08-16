"""Gmail read client — reuses the EXISTING Google OAuth token from
`google_calendar.py` (same `OAuthToken` row, provider="google_calendar").
No new OAuth app, no new auth routes: Calendar's token already refreshes
itself, so this module just needs the Gmail read scope granted on it.

Setup (captain to-do, one-time, in Google Cloud Console — same project
Calendar already uses):
  1. Open the OAuth consent screen config for the existing Calendar OAuth
     client.
  2. Add scope: https://www.googleapis.com/auth/gmail.readonly
  3. No new env vars needed — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
     GOOGLE_REDIRECT_URI (already set for Calendar) are reused as-is.
  4. Reconnect via /auth/google/start once — Google only issues a token
     carrying the new scope after the user re-consents (the `SCOPES` list
     in google_calendar.py now requests gmail.readonly up front, and
     `prompt=consent` forces a fresh grant screen every time).

If the existing OAuthToken row predates this scope add, `get_valid_access_token`
still returns a token — it just won't carry gmail.readonly until the captain
reconnects. Gmail calls will 403 with insufficientPermissions until then.
"""

from __future__ import annotations

from typing import Any

import httpx
from sqlalchemy.orm import Session

from . import google_calendar as gcal


GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"


def _headers(db: Session) -> dict[str, str]:
    access_token = gcal.get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("Gmail not connected (uses the Calendar Google connection)")
    return {"Authorization": f"Bearer {access_token}"}


def list_threads(
    db: Session,
    q: str | None = None,
    max_results: int = 20,
    page_token: str | None = None,
) -> dict[str, Any]:
    """List thread stubs (id, snippet) in the inbox. `q` uses Gmail's search
    syntax (e.g. "is:unread from:someone@example.com")."""
    params: dict[str, Any] = {"maxResults": max_results}
    if q:
        params["q"] = q
    if page_token:
        params["pageToken"] = page_token
    resp = httpx.get(
        f"{GMAIL_API}/threads",
        headers=_headers(db),
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_thread(db: Session, thread_id: str, format: str = "metadata") -> dict[str, Any]:
    """Full thread w/ messages. `format` = metadata (headers only, cheap) |
    full (bodies) | minimal."""
    resp = httpx.get(
        f"{GMAIL_API}/threads/{thread_id}",
        headers=_headers(db),
        params={"format": format},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def search(db: Session, q: str, max_results: int = 20) -> dict[str, Any]:
    """Search messages (not threads) via Gmail's `q` query language. Thin
    wrapper over `users.messages.list` — separate from list_threads because
    a search hit is a message, not necessarily the whole thread."""
    resp = httpx.get(
        f"{GMAIL_API}/messages",
        headers=_headers(db),
        params={"q": q, "maxResults": max_results},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_message(db: Session, message_id: str, format: str = "metadata") -> dict[str, Any]:
    resp = httpx.get(
        f"{GMAIL_API}/messages/{message_id}",
        headers=_headers(db),
        params={"format": format},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def is_configured() -> bool:
    """Gmail rides the Calendar OAuth client — same env vars."""
    return gcal.is_configured()


def connection_status(db: Session) -> dict[str, Any]:
    """Reuses Calendar's connection row. `scope` on that row tells you
    whether gmail.readonly was actually granted (present after a reconnect
    post-scope-add)."""
    status = gcal.connection_status(db)
    from ..db.models import OAuthToken

    row = db.query(OAuthToken).filter(OAuthToken.provider == "google_calendar").first()
    scope = row.scope if row else ""
    status["gmail_scope_granted"] = "gmail.readonly" in (scope or "")
    return status
