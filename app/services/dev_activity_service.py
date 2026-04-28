"""Dev Activity service — pulls commits from tracked repos via the GitHub
REST API and assembles the dashboard payload.

Single-tenant, single-process — keeps a tiny in-memory cache (60s) over
the full /dashboard/dev-activity payload to absorb dashboard re-mounts
without re-spending GitHub API budget.

Timezone: all "day" bucketing is UTC for v1. Refining to user-local TZ
is a follow-up.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import TrackedRepo
from ..llm.client import llm_client
from . import github as gh


_CACHE_TTL_SECONDS = 60
_SUMMARY_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "misc"
)


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
                "week_summary": None,
            }
            self._cache_at = now
            self._cache_payload = payload
            return payload

        today_utc = datetime.now(timezone.utc).date()
        since_iso = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        repos_payload: list[dict[str, Any]] = []
        union_days: set[str] = set()
        # (provider, owner, name, head_sha) tuples — drives summary cache key.
        head_shas: list[tuple[str, str, str, str]] = []
        # repo_key -> list of {subject, body, day} for the LLM prompt.
        commits_for_summary: dict[str, list[dict[str, str]]] = {}

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

            head_shas.append((
                "github", tr.owner, tr.name,
                commits[0]["sha"] if commits else "",
            ))
            commits_for_summary[f"{tr.owner}/{tr.name}"] = []

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
                commits_for_summary[f"{tr.owner}/{tr.name}"].append({
                    "subject": subject,
                    "body": body,
                    "day": day,
                })
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

        week_summary = _weekly_summary(head_shas, commits_for_summary)

        payload = {
            "configured": configured,
            "connected": connected,
            "repos": repos_payload,
            "aggregate": {
                "streak_days": aggregate_streak,
                "today_commits": aggregate_today,
            },
            "week_summary": week_summary,
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


def _weekly_summary(
    head_shas: list[tuple[str, str, str, str]],
    commits_by_repo: dict[str, list[dict[str, str]]],
) -> str | None:
    """LLM-summarize the past 7 days of commits across all tracked repos.
    Cached on disk by SHA-256 of the sorted (provider, owner, name, head_sha)
    tuples — stable while no new commits land. Best-effort: returns None on
    any error rather than failing the whole dashboard.
    """
    total_commits = sum(len(v) for v in commits_by_repo.values())
    if total_commits == 0:
        return None

    key_input = "|".join(
        f"{p}/{o}/{n}@{s}" for p, o, n, s in sorted(head_shas)
    )
    cache_key = hashlib.sha256(key_input.encode()).hexdigest()[:16]
    cache_path = os.path.join(_SUMMARY_CACHE_DIR, f"dev_summary_{cache_key}.json")

    # Cache hit — return persisted summary.
    if os.path.exists(cache_path):
        try:
            with open(cache_path) as f:
                return json.load(f).get("summary")
        except Exception:
            pass

    # Build the prompt: group by repo, list each commit subject + body.
    lines: list[str] = []
    for repo_key, commits in commits_by_repo.items():
        if not commits:
            continue
        lines.append(f"### {repo_key}")
        for c in commits:
            lines.append(f"- {c['subject']}")
            if c["body"]:
                # Indent body so the LLM treats it as commit detail.
                for bl in c["body"].splitlines():
                    if bl.strip():
                        lines.append(f"    {bl.strip()}")
    commits_block = "\n".join(lines)

    prompt = (
        "Summarize the past 7 days of development across the repos below. "
        "Write one short paragraph (3–4 sentences). Highlight the dominant "
        "theme, what shipped, and any noticeable refactors. Plain prose — "
        "no headers, no bullet lists.\n\n"
        f"{commits_block}"
    )

    try:
        summary = llm_client.generate_simple_completion(prompt, max_tokens=400)
    except Exception:
        return None

    summary = (summary or "").strip()
    if not summary:
        return None

    try:
        os.makedirs(_SUMMARY_CACHE_DIR, exist_ok=True)
        with open(cache_path, "w") as f:
            json.dump({
                "summary": summary,
                "generated_at": datetime.utcnow().isoformat() + "Z",
                "head_shas": [list(t) for t in head_shas],
            }, f)
    except Exception:
        pass
    return summary


dev_activity_service = DevActivityService()
