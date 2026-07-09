"""LeetCode integration — public-data-only client.

Hits LeetCode's unofficial GraphQL endpoint (leetcode.com/graphql) — the
same one the website uses for profile pages. No auth, no SDK.

Lazy daily pull pattern: `get_or_fetch(db)` returns today's payload
dict, fetching from LeetCode + upserting if today's entry doesn't exist
yet. First viewer per day pays ~500ms; rest hit cache. Slice 5: cached
as the `leetcode` json master Trackable entry (+ numeric mirrors for
the pivot/overlay) — the LeetcodeSnapshot table is gone.

Only public username-based stats. Cookie-auth path is intentionally not
implemented yet.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session


log = logging.getLogger(__name__)

GRAPHQL_URL = "https://leetcode.com/graphql"
DEFAULT_USERNAME = "gubith1"
HTTP_TIMEOUT = 15.0


def get_username() -> str:
    return os.getenv("LEETCODE_USERNAME") or DEFAULT_USERNAME


_PROFILE_QUERY = """
query userPublicProfile($username: String!) {
  matchedUser(username: $username) {
    profile { ranking }
  }
}
"""

_STATS_QUERY = """
query userSessionProgress($username: String!) {
  matchedUser(username: $username) {
    submitStats {
      acSubmissionNum { difficulty count }
    }
  }
}
"""

_CALENDAR_QUERY = """
query userProfileCalendar($username: String!) {
  matchedUser(username: $username) {
    userCalendar {
      streak
      totalActiveDays
      submissionCalendar
    }
  }
}
"""


def _post(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        # LeetCode rejects requests with no Referer in some cases; setting
        # this matches what their own profile pages send.
        "Referer": f"https://leetcode.com/{variables.get('username', '')}/",
    }
    resp = httpx.post(
        GRAPHQL_URL,
        json={"query": query, "variables": variables},
        headers=headers,
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "errors" in payload:
        raise RuntimeError(f"LeetCode GraphQL error: {payload['errors']}")
    return payload.get("data") or {}


def _utc_midnight_ts(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def _compute_today_and_week(calendar: dict[str, int], today: date) -> tuple[int, int]:
    """today_count + week_count (last 7 days inclusive of today)."""
    today_count = int(calendar.get(str(_utc_midnight_ts(today)), 0))
    week_count = 0
    for offset in range(7):
        d = today - timedelta(days=offset)
        week_count += int(calendar.get(str(_utc_midnight_ts(d)), 0))
    return today_count, week_count


def fetch_remote(username: str) -> dict[str, Any]:
    """Run the 3 public GraphQL queries. Returns a flat dict ready for upsert."""
    profile = _post(_PROFILE_QUERY, {"username": username})
    stats = _post(_STATS_QUERY, {"username": username})
    cal = _post(_CALENDAR_QUERY, {"username": username})

    matched = profile.get("matchedUser") or {}
    if not matched:
        raise RuntimeError(f"LeetCode user not found: {username}")

    ranking = (matched.get("profile") or {}).get("ranking")

    ac_nums = (
        ((stats.get("matchedUser") or {}).get("submitStats") or {}).get("acSubmissionNum")
        or []
    )
    by_diff = {row.get("difficulty"): int(row.get("count") or 0) for row in ac_nums}

    user_cal = ((cal.get("matchedUser") or {}).get("userCalendar")) or {}
    raw_cal_str = user_cal.get("submissionCalendar") or "{}"
    try:
        calendar = json.loads(raw_cal_str)
    except json.JSONDecodeError:
        calendar = {}

    today = datetime.now(timezone.utc).date()
    today_count, week_count = _compute_today_and_week(calendar, today)

    return {
        "username": username,
        "ranking": ranking,
        "streak": user_cal.get("streak"),
        "total_active_days": user_cal.get("totalActiveDays"),
        "today_count": today_count,
        "week_count": week_count,
        "total_solved": by_diff.get("All"),
        "easy_solved": by_diff.get("Easy"),
        "medium_solved": by_diff.get("Medium"),
        "hard_solved": by_diff.get("Hard"),
        "calendar_json": raw_cal_str,
    }


MASTER_KEY = "leetcode"
# Numeric mirrors for the pivot/overlay — headline metrics only.
_NUMERIC_KEYS: tuple[tuple[str, str], ...] = (
    ("leetcode solved", "total_solved"),
    ("leetcode today", "today_count"),
    ("leetcode streak", "streak"),
)


def _entry_for_day(db: Session, day: date):
    from ..db.models import TrackableEntry
    from . import trackable_service

    t = trackable_service.get_by_name(db, MASTER_KEY)
    if t is None:
        return None
    entries = trackable_service.entries_for(db, t, start=day, end=day)
    val = trackable_service.day_value(entries, t)
    return val if isinstance(val, dict) else None


def _latest_payload(db: Session) -> dict[str, Any] | None:
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


def upsert_today_snapshot(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist today's stats as Trackable entries (replace-mode per UTC
    day, matching the old one-row-per-date semantics). Returns the
    JSON-safe payload dict."""
    from . import trackable_service

    today = datetime.now(timezone.utc).date()
    doc = dict(payload)
    doc["snapshot_date"] = today.isoformat()
    doc["updated_at"] = datetime.utcnow().isoformat()

    master = trackable_service.create(
        db, name=MASTER_KEY, kind="json", agg="last", source="leetcode",
        schema_hint={"description": "daily leetcode rollup: solved/streak/calendar"},
    )
    trackable_service.log_entry(
        db, master, day=today, value_json=doc, source="leetcode", replace=True,
    )
    for name, key in _NUMERIC_KEYS:
        val = doc.get(key)
        if val is None:
            continue
        t = trackable_service.create(
            db, name=name, kind="numeric", agg="last", source="leetcode",
        )
        trackable_service.log_entry(
            db, t, day=today, value_numeric=float(val), source="leetcode", replace=True,
        )
    return doc


def get_or_fetch(db: Session, force: bool = False) -> dict[str, Any] | None:
    """Return today's payload. Lazy-fetch + upsert if missing.

    On fetch failure, fall back to the most-recent prior entry so the UI
    doesn't black out when LeetCode is flaky.
    """
    today = datetime.now(timezone.utc).date()
    doc = _entry_for_day(db, today)
    if doc is not None and not force:
        return doc

    try:
        payload = fetch_remote(get_username())
    except Exception as exc:
        log.warning("leetcode fetch failed: %s", exc)
        return doc or _latest_payload(db)

    return upsert_today_snapshot(db, payload)


def serialize(doc: dict[str, Any] | None) -> dict[str, Any]:
    if doc is None:
        return {"available": False}
    try:
        calendar = json.loads(doc.get("calendar_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        calendar = {}
    return {
        "available": True,
        "username": doc.get("username"),
        "snapshot_date": doc.get("snapshot_date"),
        "streak": doc.get("streak"),
        "total_active_days": doc.get("total_active_days"),
        "today_count": doc.get("today_count"),
        "week_count": doc.get("week_count"),
        "total_solved": doc.get("total_solved"),
        "easy_solved": doc.get("easy_solved"),
        "medium_solved": doc.get("medium_solved"),
        "hard_solved": doc.get("hard_solved"),
        "ranking": doc.get("ranking"),
        "calendar": calendar,
        "updated_at": doc.get("updated_at"),
    }
