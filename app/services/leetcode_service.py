"""LeetCode integration — public-data-only client.

Hits LeetCode's unofficial GraphQL endpoint (leetcode.com/graphql) — the
same one the website uses for profile pages. No auth, no SDK.

Lazy daily pull pattern: `get_or_fetch(db)` returns today's
`LeetcodeSnapshot` row, fetching from LeetCode + upserting if today's
row doesn't exist yet. First viewer per day pays ~500ms; rest hit cache.

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

from ..db.models import LeetcodeSnapshot

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


def upsert_today_snapshot(db: Session, payload: dict[str, Any]) -> LeetcodeSnapshot:
    today = datetime.now(timezone.utc).date()
    row = db.query(LeetcodeSnapshot).filter(LeetcodeSnapshot.date == today).first()
    if row is None:
        row = LeetcodeSnapshot(date=today)
        db.add(row)
    for field in (
        "username",
        "streak",
        "total_active_days",
        "today_count",
        "week_count",
        "total_solved",
        "easy_solved",
        "medium_solved",
        "hard_solved",
        "ranking",
        "calendar_json",
    ):
        if field in payload:
            setattr(row, field, payload[field])
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


def get_or_fetch(db: Session, force: bool = False) -> LeetcodeSnapshot | None:
    """Return today's snapshot. Lazy-fetch + upsert if missing.

    On fetch failure, fall back to the most-recent prior row so the UI
    doesn't black out when LeetCode is flaky.
    """
    today = datetime.now(timezone.utc).date()
    row = db.query(LeetcodeSnapshot).filter(LeetcodeSnapshot.date == today).first()
    if row is not None and not force:
        return row

    try:
        payload = fetch_remote(get_username())
    except Exception as exc:
        log.warning("leetcode fetch failed: %s", exc)
        if row is not None:
            return row
        return (
            db.query(LeetcodeSnapshot)
            .order_by(LeetcodeSnapshot.date.desc())
            .first()
        )

    return upsert_today_snapshot(db, payload)


def serialize(row: LeetcodeSnapshot | None) -> dict[str, Any]:
    if row is None:
        return {"available": False}
    try:
        calendar = json.loads(row.calendar_json or "{}")
    except json.JSONDecodeError:
        calendar = {}
    return {
        "available": True,
        "username": row.username,
        "snapshot_date": row.date.isoformat() if row.date else None,
        "streak": row.streak,
        "total_active_days": row.total_active_days,
        "today_count": row.today_count,
        "week_count": row.week_count,
        "total_solved": row.total_solved,
        "easy_solved": row.easy_solved,
        "medium_solved": row.medium_solved,
        "hard_solved": row.hard_solved,
        "ranking": row.ranking,
        "calendar": calendar,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
