"""Ultrahuman ring integration — mirrors the shape of `whoop.py` (fetch →
json master Trackable + numeric mirrors, replace-mode per local day), but
API-KEY auth instead of OAuth: Ultrahuman's public "Partner API" is a
single API key + the user's account email, not a 3-legged OAuth dance.

STATUS: STUB. Ultrahuman does not publish a self-serve developer portal like
Whoop's developer.whoop.com — the Partner API (docs at
https://www.ultrahuman.com/blog/ultrahuman-partner-api/ as of this writing)
is provisioned per-partner by their team, and the exact request/response
shape below is written from that blog post + community reports, NOT
verified against a live account. TREAT THE ENDPOINT PATH AND RESPONSE
PARSING AS UNCONFIRMED until the captain has a real key to test against.

Setup (captain to-do):
  1. Request Partner API access — see https://www.ultrahuman.com (as of
     writing there's no public self-serve signup; likely requires emailing
     Ultrahuman support/partnerships).
  2. Once issued a key, set env vars:
       ULTRAHUMAN_API_KEY     — the partner API key
       ULTRAHUMAN_EMAIL       — the Ultrahuman account email the key reads
                                 metrics for (their API scopes by email,
                                 not a per-user OAuth token)
  3. TODO(captain): confirm the actual base URL + auth header name once you
     have real credentials — `API_BASE` / `_headers()` below are best-guess
     from public docs and WILL need adjusting. `fetch_today_snapshot` has a
     single `_get()` call site, so fixing the URL/params is a one-function
     patch.

Data pulled: sleep score, recovery/HRV, activity/steps — same "daily
rollup" shape whoop.py produces, so it slots into the same trackable
pattern (one json master + numeric mirrors) with no new concepts.
"""

from __future__ import annotations

import os
from datetime import date as date_cls, datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session


def _local_today(db: Session) -> date_cls:
    from ..common import local_today
    return local_today(db)


# TODO(captain): unverified — confirm against Ultrahuman's real Partner API
# docs once a key is issued. This is the publicly-referenced base as of
# writing; may need a version prefix or a different host entirely.
API_BASE = "https://partner.ultrahuman.com/api/v1"

PROVIDER = "ultrahuman"


def _env() -> tuple[str | None, str | None]:
    return (
        os.getenv("ULTRAHUMAN_API_KEY"),
        os.getenv("ULTRAHUMAN_EMAIL"),
    )


def is_configured() -> bool:
    api_key, email = _env()
    return bool(api_key and email)


def connection_status(db: Session) -> dict[str, Any]:
    """No OAuthToken row — this is API-key auth, so "connected" just means
    "configured". Kept as its own function (not is_configured() directly)
    so the router/frontend shape matches whoop's connection_status()."""
    configured = is_configured()
    return {
        "configured": configured,
        "connected": configured,
        "account_email": os.getenv("ULTRAHUMAN_EMAIL") if configured else None,
    }


def _headers() -> dict[str, str]:
    api_key, _ = _env()
    if not api_key:
        raise RuntimeError("Ultrahuman not configured (ULTRAHUMAN_API_KEY missing)")
    # TODO(captain): unverified header name — Whoop/Google use Bearer, but
    # partner-style APIs often use a custom header (e.g. "Authorization: <key>"
    # with no "Bearer " prefix, or "X-API-Key"). Confirm once you have a key.
    return {"Authorization": api_key}


def _get(path: str, params: dict | None = None) -> dict[str, Any]:
    resp = httpx.get(
        f"{API_BASE}{path}",
        headers=_headers(),
        params=params or {},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_today_snapshot(db: Session) -> dict[str, Any] | None:
    """Pull today's sleep/recovery/activity and roll into one dict, same
    shape whoop.upsert_today_snapshot() consumes. Returns None if not
    configured.

    TODO(captain): the `metrics` endpoint + `email`/`date` params below are
    the best-guess shape from public docs — the actual response envelope
    (nesting, field names) needs confirming against a real key before this
    can be trusted. Everything downstream (upsert_today_snapshot, the
    numeric mirrors) reads off the dict this function returns, so fixing
    the parsing here is the only place that needs to change.
    """
    if not is_configured():
        return None
    _, email = _env()
    today = _local_today(db)

    # TODO(captain): confirm path — could be "/metrics", "/user/metrics", etc.
    data = _get("/metrics", params={"email": email, "date": today.isoformat()})

    # TODO(captain): confirm field paths once the real response shape is known.
    sleep = data.get("sleep") or {}
    recovery = data.get("recovery") or {}
    activity = data.get("activity") or {}

    return {
        "sleep_score": sleep.get("score"),
        "sleep_minutes": sleep.get("duration_minutes"),
        "recovery_score": recovery.get("score") or recovery.get("recovery_index"),
        "hrv_ms": recovery.get("hrv") or recovery.get("hrv_ms"),
        "resting_hr": recovery.get("resting_heart_rate"),
        "steps": activity.get("steps"),
        "active_calories": activity.get("active_calories"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Trackable feed (mirrors whoop.py's pattern exactly) ────────────────

MASTER_KEY = "ultrahuman"
_NUMERIC_KEYS: tuple[tuple[str, str, str | None], ...] = (
    # (trackable name, payload key, unit)
    ("ultrahuman sleep score", "sleep_score", "%"),
    ("ultrahuman recovery", "recovery_score", "%"),
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
