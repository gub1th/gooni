"""Gooni's Take — daily reflection on how the app + the user evolved.

Produces a per-day snapshot with two flavors of input:

  1. Code/feature evolution: commits pushed to the gooni repo in the last 24h
     (via the existing GitHub integration; the user must have it tracked).
  2. User activity deltas: counts of notes / focuses / memories / messages
     today, compared against the prior snapshot's counts.

The LLM digest is two short paragraphs — one on Gooni's evolution, one on
Daniel's activity — surfaced inside the Dev Activity popover so the
"current state of Gooni" reading sits next to the live commit feed.

Lazy build: the GET endpoint creates today's row on first call, so there's
no separate cron to maintain.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import (
    Conversation, GooniSnapshot, Memory, Message, Note, TrackedRepo, ListItem,
)
from ..llm.client import llm_client
from . import github as gh


# Pinned to the gooni repo for "code evolution" inputs. If we ever fork
# Gooni's brain into multiple repos, switch to a settings-table list.
_GOONI_REPO_OWNER = "gub1th"
_GOONI_REPO_NAME = "gooni"

# Eval baselines live here. Snapshot ingests the most recent one so the
# daily digest can reference quality scores ("composite up from 73 → 81").
_BASELINES_DIR = Path(__file__).parent.parent.parent / "evals" / "baselines"


class SnapshotService:
    def get_or_build_today(self, db: Session) -> GooniSnapshot:
        today_key = date.today().isoformat()
        existing = db.query(GooniSnapshot).filter(GooniSnapshot.day == today_key).first()
        if existing and existing.digest:
            return existing
        # Build (or rebuild if a previous attempt left digest empty).
        raw = self._gather_raw(db)
        prev = self._previous_snapshot(db, today_key)
        prev_raw = json.loads(prev.raw_data) if (prev and prev.raw_data) else None
        digest = self._digest(raw, prev_raw)
        if existing:
            existing.raw_data = json.dumps(raw)
            existing.digest = digest
            existing.taken_at = datetime.utcnow()
        else:
            existing = GooniSnapshot(
                day=today_key,
                raw_data=json.dumps(raw),
                digest=digest,
                taken_at=datetime.utcnow(),
            )
            db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    # ── raw inputs ──────────────────────────────────────────────────────

    def _gather_raw(self, db: Session) -> dict[str, Any]:
        """Snapshot inputs. Best-effort — any partial failure (e.g. GitHub
        token expired) is degraded gracefully so the digest still runs."""
        return {
            "ts": datetime.utcnow().isoformat(),
            "gooni_commits": self._fetch_gooni_commits_24h(db),
            "counts": self._db_counts(db),
            "eval": self._latest_baseline(),
        }

    def _latest_baseline(self) -> dict[str, Any] | None:
        """Most recent eval baseline JSON. Returns the trimmed shape the
        digest needs (composite, means, model, source hash) — full results
        list is too fat for the prompt and not needed at digest time.

        Returns None if no baselines have been generated yet.
        """
        if not _BASELINES_DIR.exists():
            return None
        candidates = sorted(_BASELINES_DIR.glob("baseline_*.json"))
        if not candidates:
            return None
        # Latest by filename (filenames include PROMPT_VERSION + model so
        # alphabetical works for sibling versions; for chronological "latest"
        # use mtime instead).
        latest = max(candidates, key=lambda p: p.stat().st_mtime)
        try:
            data = json.loads(latest.read_text())
        except (json.JSONDecodeError, OSError):
            return None
        return {
            "file": latest.name,
            "timestamp": data.get("timestamp"),
            "pipeline_version": data.get("pipeline_version"),
            "pipeline_model": data.get("pipeline_model"),
            "pipeline_source_hash": data.get("pipeline_source_hash"),
            "n_cases": data.get("n_cases"),
            "passed": data.get("passed"),
            "failed": data.get("failed"),
            "composite_score": data.get("composite_score"),
            "means": data.get("means"),
        }

    def _fetch_gooni_commits_24h(self, db: Session) -> list[dict[str, Any]]:
        # Only attempt the fetch when the user has actually tracked the
        # gooni repo — otherwise it'd be a wasted token round-trip.
        tracked = (
            db.query(TrackedRepo)
            .filter(TrackedRepo.provider == "github")
            .filter(TrackedRepo.owner == _GOONI_REPO_OWNER)
            .filter(TrackedRepo.name == _GOONI_REPO_NAME)
            .first()
        )
        if not tracked:
            return []
        since = (datetime.utcnow() - timedelta(days=1)).isoformat() + "Z"
        try:
            commits = gh.list_recent_commits(db, _GOONI_REPO_OWNER, _GOONI_REPO_NAME, since)
        except Exception as e:
            print(f"[snapshot] gooni commit fetch failed: {e}")
            return []
        # Trim to fields the digest actually needs — full GitHub response is fat.
        return [
            {
                "sha": c.get("sha", "")[:7],
                "subject": (c.get("commit", {}).get("message", "") or "").split("\n", 1)[0],
                "author": c.get("commit", {}).get("author", {}).get("name"),
                "date": c.get("commit", {}).get("author", {}).get("date"),
            }
            for c in commits
        ]

    def _db_counts(self, db: Session) -> dict[str, int]:
        return {
            "notes": db.query(Note).count(),
            "conversations": db.query(Conversation).count(),
            "messages": db.query(Message).count(),
            "memories": db.query(Memory).count(),
            "focuses": db.query(ListItem).filter(ListItem.endgoal.isnot(None)).count(),
            "items_total": db.query(ListItem).count(),
        }

    def _previous_snapshot(self, db: Session, today_key: str) -> GooniSnapshot | None:
        return (
            db.query(GooniSnapshot)
            .filter(GooniSnapshot.day != today_key)
            .order_by(GooniSnapshot.day.desc())
            .first()
        )

    # ── LLM digest ──────────────────────────────────────────────────────

    def _digest(self, raw: dict[str, Any], prev_raw: dict[str, Any] | None) -> str:
        commits = raw.get("gooni_commits") or []
        counts = raw.get("counts", {})
        prev_counts = (prev_raw or {}).get("counts") or {}
        deltas = {k: counts.get(k, 0) - prev_counts.get(k, 0) for k in counts}

        commit_lines = "\n".join(
            f"- {c['sha']}: {c['subject']}" for c in commits[:20]
        ) or "(no commits in the last 24h)"

        delta_lines = "\n".join(
            f"- {k}: {prev_counts.get(k, 0)} → {counts.get(k, 0)} ({'+' if deltas[k] >= 0 else ''}{deltas[k]})"
            for k in counts
        )

        # Eval delta — shows quality movement vs prior snapshot, not just
        # raw activity volume. This is the signal Daniel cares about for
        # "am I actually improving Gooni or just changing it?"
        eval_block = self._format_eval_block(raw.get("eval"), (prev_raw or {}).get("eval"))

        prompt = f"""You are Gooni — a self-aware personal AI notebook + assistant
built by Daniel. Write a short daily reflection in three paragraphs:

Paragraph 1 — "How I evolved": one tight paragraph summarizing what changed
in the codebase over the last 24 hours, based on the commits below. Be
specific about features, not generic. If nothing notable shipped, say so
in one short sentence — don't pad.

Paragraph 2 — "Quality state": reference the eval scores below. Composite is
0-100. If composite moved from prior snapshot, name the direction and any
dim that drove it (groundedness, follows_prefs, no_hallucination, helpful).
If no eval data yet, say "no baseline locked yet" and skip the paragraph.

Paragraph 3 — "What Daniel's been up to": one paragraph reading the activity
deltas (notes/conversations/focuses/memories) and naming what stands out.
If nothing meaningful changed, say it directly.

Voice: first-person, plain, slightly self-aware. No headers, no bullets,
no filler ("today I…"). Each paragraph 2-3 sentences max. Skip metric
names that didn't move.

Commits in the gooni repo (last 24h):
{commit_lines}

Eval state (latest baseline):
{eval_block}

Activity deltas (yesterday's snapshot → now):
{delta_lines if delta_lines else "(no prior snapshot)"}
"""

        try:
            return llm_client.generate_simple_completion(prompt, max_tokens=400)
        except Exception as e:
            print(f"[snapshot] digest failed: {e}")
            return ""

    def _format_eval_block(
        self,
        cur: dict[str, Any] | None,
        prev: dict[str, Any] | None,
    ) -> str:
        """Render eval baseline (current + delta vs prior) as plain text for
        the digest prompt. Best to inline here so the prompt stays terse."""
        if not cur:
            return "(no baseline yet — run `python -m evals.run_orchestrator --baseline`)"
        lines = [
            f"composite: {cur.get('composite_score', '?')}/100",
            f"pass: {cur.get('passed', '?')}/{cur.get('n_cases', '?')}",
            f"means: {cur.get('means') or '{}'}",
            f"pipeline: {cur.get('pipeline_model', '?')} (PROMPT_VERSION={cur.get('pipeline_version', '?')}, src={cur.get('pipeline_source_hash', '?')})",
        ]
        if prev and prev.get("composite_score") is not None and cur.get("composite_score") is not None:
            delta = cur["composite_score"] - prev["composite_score"]
            arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "→")
            lines.append(f"vs prior snapshot: {prev['composite_score']} {arrow} {cur['composite_score']} ({'+' if delta >= 0 else ''}{round(delta, 1)})")
        return "\n".join(lines)


snapshot_service = SnapshotService()
