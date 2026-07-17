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

import json
import os
import secrets
import time
import urllib.parse
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Any
import httpx
from sqlalchemy.orm import Session

from ..db.models import OAuthToken


def _local_today(db: Session) -> date_cls:
    """Today in Daniel's configured TZ — thin alias over common.local_today
    (the shared helper). Kept as a local name so existing call sites in this
    module + the whoop router don't have to change. UTC date would key
    snapshots to the wrong day after ~5pm PT."""
    from ..common import local_today
    return local_today(db)


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
    """Build the Whoop authorize URL. Whoop's OAuth provider rejects state
    values shorter than 8 chars (they want enough entropy for CSRF protection),
    so we auto-generate a 16-byte URL-safe token if the caller didn't pass one.
    Single-user app — we don't currently round-trip-verify the state on
    callback, but Whoop still requires it server-side."""
    cid, _, redirect = _env()
    if not cid or not redirect:
        raise RuntimeError("Whoop OAuth env vars not set")
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
    # WHOOP migrated the public developer API from v1 → v2 in 2025; v1
    # endpoints fully sunset and now return 404. Migration kept the same
    # response shapes for the records we read, so only the URL prefix
    # changed.
    resp = httpx.get(
        f"{API_BASE}/v2/user/profile/basic",
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
    # 4-day window so the "newest scored record" lookup still finds something
    # for users who don't sync every morning. Cycle/strain wants today; recovery
    # + sleep are happy with yesterday if today hasn't scored yet.
    start = end - timedelta(days=4)
    params = {"start": start.isoformat(), "end": end.isoformat(), "limit": 10}

    recovery_records = _get(token, "/v2/recovery", params).get("records", [])
    cycle_records = _get(token, "/v2/cycle", params).get("records", [])
    sleep_records = _get(token, "/v2/activity/sleep", params).get("records", [])

    # Pick the newest record whose score field is actually populated. Whoop
    # returns in-progress / pending records with `score: null` or an empty
    # dict — picking those by created_at alone would surface a "scored 0%"
    # ghost row. Sorts by `updated_at` then `created_at`, both defensive
    # since Whoop's order isn't a guaranteed contract.
    def _newest_scored(records: list[dict], score_key: str) -> dict | None:
        if not records:
            return None
        def _ts(r: dict) -> str:
            return r.get("updated_at") or r.get("created_at") or ""
        scored = [r for r in records if (r.get("score") or {}).get(score_key) is not None]
        if scored:
            return sorted(scored, key=_ts, reverse=True)[0]
        # Fallback: newest record at all. Score may still be null — fine,
        # downstream `.get()`s will yield None and the UI shows "—".
        return sorted(records, key=_ts, reverse=True)[0]

    recovery = _newest_scored(recovery_records, "recovery_score") or {}
    cycle = _newest_scored(cycle_records, "strain") or {}
    # Sleep's headline value lives under stage_summary.total_in_bed_time_milli;
    # `sleep_performance_percentage` works as the scored-ness signal because
    # Whoop fills it in only after the sleep cycle is finalized.
    sleep = _newest_scored(sleep_records, "sleep_performance_percentage") or {}

    rec_score = (recovery.get("score") or {})
    cyc_score = (cycle.get("score") or {})
    slp_score = (sleep.get("score") or {})
    slp_stage = (slp_score.get("stage_summary") or {})

    # Newest upstream record-timestamp across all three streams. Parsed
    # from Whoop's ISO strings; tz-aware → naive UTC for storage (DB
    # column is naive). Fed to FreshnessActions so "updated 18h ago"
    # reflects Whoop's actual data age, not our cache poll.
    src_ts_strs = [
        recovery.get("updated_at") or recovery.get("created_at"),
        cycle.get("updated_at") or cycle.get("created_at"),
        sleep.get("updated_at") or sleep.get("created_at"),
    ]
    source_updated_at = None
    for s in src_ts_strs:
        if not s:
            continue
        try:
            ts = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if ts.tzinfo is not None:
                ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
            if source_updated_at is None or ts > source_updated_at:
                source_updated_at = ts
        except (ValueError, TypeError):
            continue

    # Sleep session bed/wake timestamps. Whoop returns ISO8601 w/ Z;
    # normalize to naive UTC for storage (matches `source_updated_at`).
    sleep_start_at = None
    sleep_end_at = None
    for attr, target in (("start", "sleep_start_at"), ("end", "sleep_end_at")):
        raw = sleep.get(attr)
        if not raw:
            continue
        try:
            ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if ts.tzinfo is not None:
                ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
            if target == "sleep_start_at":
                sleep_start_at = ts
            else:
                sleep_end_at = ts
        except (ValueError, TypeError):
            continue

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
        "sleep_start_at": sleep_start_at,
        "sleep_end_at": sleep_end_at,
        "sleep_efficiency_pct": slp_score.get("sleep_efficiency_percentage"),
        "sleep_disturbance_count": (
            slp_stage.get("disturbance_count") if slp_stage else None
        ),
        "fetched_at": end.isoformat(),
        "source_updated_at": source_updated_at,
    }


# ── Trackable feed (Slice 5 — WhoopSnapshot table is gone) ─────────────
#
# One json master trackable ("whoop") carries the whole day payload —
# the nudge composer, /whoop/today, and health connector read it. A few
# numeric child trackables mirror the headline metrics so the overlay's
# whoop-select zone (and any future pivot) can chart them individually.
# All replace-mode per day: webhook bursts overwrite, never stack.

MASTER_KEY = "whoop"
_NUMERIC_KEYS: tuple[tuple[str, str, str | None], ...] = (
    # (trackable name, payload key, unit)
    ("whoop recovery", "recovery_score", "%"),
    ("whoop strain", "strain", None),
    ("whoop hrv", "hrv_rmssd_ms", "ms"),
    ("whoop rhr", "resting_hr", "bpm"),
    ("whoop sleep hours", "sleep_hours", "h"),
)


def _payload_to_json(payload: dict[str, Any]) -> dict[str, Any]:
    """Datetime fields → ISO strings so the payload round-trips through
    the TrackableEntry value_json column."""
    out = dict(payload)
    for k in ("sleep_start_at", "sleep_end_at", "source_updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    if payload.get("sleep_minutes"):
        out["sleep_hours"] = round(payload["sleep_minutes"] / 60.0, 2)
    out["updated_at"] = datetime.utcnow().isoformat()
    return out


def upsert_today_snapshot(db: Session, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Persist today's whoop data as Trackable entries (idempotent per
    day — replace-mode). `today` uses Daniel's local TZ so the entries
    key on his lived day, not UTC. Returns the JSON-safe payload dict
    (the shape latest_snapshot()/get_today() hand back)."""
    from . import trackable_service

    today = _local_today(db)
    doc = _payload_to_json(payload)

    master = trackable_service.create(
        db, name=MASTER_KEY, kind="json", agg="last", source="whoop",
        schema_hint={"description": "daily whoop rollup: recovery/strain/sleep"},
    )
    trackable_service.log_entry(
        db, master, day=today, value_json=doc, source="whoop", replace=True,
    )

    for name, key, unit in _NUMERIC_KEYS:
        val = doc.get(key)
        if val is None:
            continue
        t = trackable_service.create(
            db, name=name, kind="numeric", unit=unit, agg="last", source="whoop",
        )
        trackable_service.log_entry(
            db, t, day=today, value_numeric=float(val), source="whoop", replace=True,
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


def subject_day(doc: dict[str, Any] | None, db: Session) -> date_cls | None:
    """The local calendar day a whoop reading is actually FOR — recovery is
    computed for the morning you wake, so the day the last sleep ENDED is the
    truthful subject-day (not when the poll happened to run). Falls back to the
    source/sync timestamp, then None. Used to flag a stale tile ("yesterday")
    when today's sleep hasn't synced yet."""
    if not doc:
        return None
    from ..common import local_now

    tz = local_now(db).tzinfo
    for key in ("sleep_end_at", "source_updated_at", "updated_at"):
        raw = doc.get(key)
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            continue
        if dt.tzinfo is None:  # stored naive UTC
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(tz).date()
    return None


def latest_snapshot(db: Session) -> dict[str, Any] | None:
    """Newest whoop payload regardless of day — the nudge debouncer's
    read (the burst may span local midnight)."""
    from ..db.models import TrackableEntry
    from . import trackable_service

    t = trackable_service.get_by_name(db, MASTER_KEY)
    if t is None:
        return None
    row = (
        db.query(TrackableEntry)
        .filter(TrackableEntry.trackable_id == t.id)
        .order_by(TrackableEntry.date.desc(), TrackableEntry.created_at.desc())
        .first()
    )
    if row is None or not row.value_json:
        return None
    try:
        val = json.loads(row.value_json)
    except (TypeError, ValueError):
        return None
    return val if isinstance(val, dict) else None
