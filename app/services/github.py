"""GitHub OAuth + REST client — single-user, no SDK, talks straight to
GitHub's REST endpoints via httpx. Mirrors the google_calendar.py shape
so frontend IntegrationSection can treat it interchangeably.

Setup (one-time, github.com → Settings → Developer settings → OAuth Apps):
  1. Register a new OAuth App.
  2. Authorization callback URL:
       - http://localhost:8000/auth/github/callback        (dev)
       - https://gooni-bot.fly.dev/auth/github/callback    (prod)
  3. Set env vars:
       GITHUB_CLIENT_ID
       GITHUB_CLIENT_SECRET
       GITHUB_REDIRECT_URI

Note on tokens: classic OAuth-App access tokens do not expire and there
is no refresh-token flow. We persist with expires_at = 0 ("no expiry")
and an empty refresh_token. If a token is ever revoked we re-prompt.
Scope:
  - repo                (full read+write on private + public)
  - read:user           (login / display name)
"""

from __future__ import annotations

import os
import urllib.parse
from typing import Any

import httpx
from sqlalchemy.orm import Session

from ..db.models import OAuthToken


PROVIDER = "github"
AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
API_BASE = "https://api.github.com"

SCOPES = "repo read:user"


def _env() -> tuple[str | None, str | None, str | None]:
    return (
        os.getenv("GITHUB_CLIENT_ID"),
        os.getenv("GITHUB_CLIENT_SECRET"),
        os.getenv("GITHUB_REDIRECT_URI"),
    )


def is_configured() -> bool:
    client_id, client_secret, redirect_uri = _env()
    return bool(client_id and client_secret and redirect_uri)


def build_authorize_url(state: str = "") -> str:
    client_id, _, redirect_uri = _env()
    if not client_id or not redirect_uri:
        raise RuntimeError("GitHub OAuth env vars not set")
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
        "allow_signup": "false",
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(code: str) -> dict[str, Any]:
    client_id, client_secret, redirect_uri = _env()
    if not client_id or not client_secret or not redirect_uri:
        raise RuntimeError("GitHub OAuth env vars not set")
    resp = httpx.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        },
        headers={"Accept": "application/json"},
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()
    if "access_token" not in body:
        raise RuntimeError(f"github oauth error: {body}")
    return body


def fetch_userinfo(access_token: str) -> dict[str, Any]:
    resp = httpx.get(
        USER_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def save_tokens_from_exchange(
    db: Session,
    token_response: dict[str, Any],
    account_label: str | None = None,
) -> OAuthToken:
    access_token = token_response.get("access_token")
    scope = token_response.get("scope") or ""
    if not access_token:
        raise RuntimeError(f"incomplete github token response: keys={list(token_response)}")

    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    if row is None:
        row = OAuthToken(
            provider=PROVIDER,
            access_token=access_token,
            refresh_token="",
            expires_at=0,
            scope=scope,
            account_email=account_label,
        )
        db.add(row)
    else:
        row.access_token = access_token
        row.refresh_token = ""
        row.expires_at = 0
        row.scope = scope
        if account_label:
            row.account_email = account_label
    db.commit()
    db.refresh(row)
    return row


def get_valid_access_token(db: Session) -> str | None:
    """Return the stored access token, or None if not connected. GitHub
    OAuth-App tokens don't expire, so no refresh logic.
    """
    row = db.query(OAuthToken).filter(OAuthToken.provider == PROVIDER).first()
    return row.access_token if row else None


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


# ── REST API wrappers ───────────────────────────────────────────────────


def _api_get(access_token: str, path: str, params: dict | None = None) -> Any:
    resp = httpx.get(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def list_user_repos(db: Session, per_page: int = 100) -> list[dict[str, Any]]:
    """List repos the authenticated user can access. Sorted by recent
    push activity so the most-developed repos surface first.
    """
    access_token = get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("GitHub not connected")
    return _api_get(
        access_token,
        "/user/repos",
        params={
            "per_page": per_page,
            "sort": "pushed",
            "direction": "desc",
            "affiliation": "owner,collaborator,organization_member",
        },
    )


def list_recent_commits(
    db: Session,
    owner: str,
    name: str,
    since_iso: str,
    per_page: int = 30,
) -> list[dict[str, Any]]:
    """Commits on the default branch since the given ISO timestamp."""
    access_token = get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("GitHub not connected")
    return _api_get(
        access_token,
        f"/repos/{owner}/{name}/commits",
        params={"since": since_iso, "per_page": per_page},
    )


def get_commit_stats(db: Session, owner: str, name: str, sha: str) -> dict[str, Any]:
    """Detailed commit info — includes additions/deletions/files."""
    access_token = get_valid_access_token(db)
    if not access_token:
        raise RuntimeError("GitHub not connected")
    return _api_get(access_token, f"/repos/{owner}/{name}/commits/{sha}")
