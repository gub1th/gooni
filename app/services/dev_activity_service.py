"""Dev Activity service — pulls commits from tracked repos via the GitHub
REST API and assembles the dashboard payload.

Single-tenant, single-process — keeps a tiny in-memory cache (60s) over
the full /dashboard/dev-activity payload to absorb dashboard re-mounts
without re-spending GitHub API budget.

Timezone: all "day" bucketing is UTC for v1. Refining to user-local TZ
is a follow-up.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import TrackedRepo
from . import github as gh


_CACHE_TTL_SECONDS = 60


class DevActivityService:
    def __init__(self) -> None:
        self._cache_at: float = 0.0
        self._cache_payload: dict[str, Any] | None = None

    # ── Public ─────────────────────────────────────────────────────────

    def build(self, db: Session, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if (
            not force
            and self._cache_payload is not None
            and (now - self._cache_at) < _CACHE_TTL_SECONDS
        ):
            return self._cache_payload

        configured = gh.is_configured()
        connected = gh.get_valid_access_token(db) is not None
        tracked = (
            db.query(TrackedRepo)
            .filter(TrackedRepo.provider == "github")
            .order_by(TrackedRepo.added_at.desc())
            .all()
        )

        if not connected or not tracked:
            payload = {
                "configured": configured,
                "connected": connected,
                "repos": [],
                "aggregate": {"streak_days": 0, "today_commits": 0},
            }
            self._cache_at = now
            self._cache_payload = payload
            return payload

        today_utc = datetime.now(timezone.utc).date()
        since_iso = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        repos_payload: list[dict[str, Any]] = []
        union_days: set[str] = set()
        for tr in tracked:
            try:
                commits = gh.list_recent_commits(db, tr.owner, tr.name, since_iso=since_iso)
            except Exception as e:
                repos_payload.append({
                    "owner": tr.owner,
                    "name": tr.name,
                    "error": str(e)[:200],
                })
                continue

            commit_days: set[str] = set()
            today_count = 0
            today_additions = 0
            today_deletions = 0
            today_files: set[str] = set()
            today_subjects: list[str] = []
            recent: list[dict[str, Any]] = []

            for c in commits:
                committed_at = (
                    (c.get("commit") or {}).get("committer") or {}
                ).get("date") or (
                    (c.get("commit") or {}).get("author") or {}
                ).get("date")
                if not committed_at:
                    continue
                day = committed_at[:10]  # YYYY-MM-DD
                commit_days.add(day)
                union_days.add(day)
                msg = (c.get("commit") or {}).get("message") or ""
                subject = msg.split("\n", 1)[0]
                body = msg.split("\n", 1)[1].strip() if "\n" in msg else ""
                if len(recent) < 5:
                    recent.append({
                        "sha": c.get("sha", "")[:7],
                        "subject": subject,
                        "body": body,
                        "html_url": c.get("html_url"),
                        "committed_at": committed_at,
                    })

                if day == today_utc.isoformat():
                    today_count += 1
                    today_subjects.append(subject)
                    # Extra API call for additions/deletions/files. Capped
                    # implicitly by today_count being small.
                    try:
                        stats = gh.get_commit_stats(db, tr.owner, tr.name, c["sha"])
                        s = stats.get("stats") or {}
                        today_additions += int(s.get("additions", 0))
                        today_deletions += int(s.get("deletions", 0))
                        for f in stats.get("files", []) or []:
                            fn = f.get("filename")
                            if fn:
                                today_files.add(fn)
                    except Exception:
                        pass

            repos_payload.append({
                "owner": tr.owner,
                "name": tr.name,
                "today": {
                    "commits": today_count,
                    "additions": today_additions,
                    "deletions": today_deletions,
                    "files_changed": len(today_files),
                    "subjects": today_subjects,
                },
                "recent": recent,
                "streak_days": _streak_from_days(commit_days, today_utc),
            })

        aggregate_streak = _streak_from_days(union_days, today_utc)
        aggregate_today = sum((r.get("today") or {}).get("commits", 0) for r in repos_payload)

        payload = {
            "configured": configured,
            "connected": connected,
            "repos": repos_payload,
            "aggregate": {
                "streak_days": aggregate_streak,
                "today_commits": aggregate_today,
            },
        }

        self._cache_at = now
        self._cache_payload = payload
        return payload

    def invalidate(self) -> None:
        self._cache_at = 0.0
        self._cache_payload = None


def _streak_from_days(days: set[str], today) -> int:
    """Count consecutive days back from `today` that appear in `days`.
    Stops at the first gap. `today` is a date.
    """
    streak = 0
    cursor = today
    while cursor.isoformat() in days:
        streak += 1
        cursor = cursor - timedelta(days=1)
    return streak



dev_activity_service = DevActivityService()
