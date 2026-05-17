"""Recent activity read tools — surface what Daniel shipped + what's on
the backlog. Fixes T3 of eval segment #209 where he asked "what PRs did
i push" and Gooni had no way to know.

Read-only (no DB writes). Fits the future phase-5 read-only chat tool
surface in the unified-extractor plan.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .base import BaseTool


class ReadRecentCommitsTool(BaseTool):
    name = "read_recent_commits"
    description = (
        "Read Daniel's recent git commits across tracked GitHub repos. "
        "Use when he asks 'what did I push', 'what shipped today/this week', "
        "'recent commits', or anything about coding activity. Returns "
        "per-repo commit subjects with dates (last N days)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "days": {
                "type": "integer",
                "description": "Window in days (default 7, max 30).",
                "default": 7,
            },
            "limit_per_repo": {
                "type": "integer",
                "description": "Max commits per repo (default 8).",
                "default": 8,
            },
        },
        "required": [],
    }

    def execute(
        self,
        db=None,
        days: int = 7,
        limit_per_repo: int = 8,
        **kwargs,
    ) -> str:
        from ..services.dev_activity_service import DevActivityService

        if db is None:
            return "(no db session)"

        days = max(1, min(int(days or 7), 30))
        limit = max(1, min(int(limit_per_repo or 8), 25))

        try:
            payload = DevActivityService().build(db, force=False)
        except Exception as e:
            return f"(dev activity error: {e})"

        if not payload.get("connected"):
            return "(github not connected — can't read commits)"

        repos = payload.get("repos") or []
        if not repos:
            return "(no tracked repos)"

        cutoff_day = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
        out_lines: list[str] = []
        for r in repos:
            if r.get("error"):
                out_lines.append(f"## {r.get('owner')}/{r.get('name')} — error: {r['error']}")
                continue
            recent = r.get("recent") or []
            in_window = [c for c in recent if (c.get("day") or "") >= cutoff_day]
            if not in_window:
                continue
            head = f"## {r.get('owner')}/{r.get('name')}"
            lines = [head]
            for c in in_window[:limit]:
                subj = (c.get("subject") or "").strip()
                day = c.get("day") or "?"
                if subj:
                    lines.append(f"- {day}: {subj}")
            out_lines.append("\n".join(lines))

        if not out_lines:
            return f"(no commits in last {days}d across tracked repos)"
        return "\n\n".join(out_lines)


class ReadRecentBacklogTool(BaseTool):
    name = "read_recent_backlog"
    description = (
        "Read recently created or closed backlog tickets. Use when Daniel "
        "asks 'what's on the backlog', 'what got shipped', 'what feature "
        "requests are pending', or any backlog-recap question. Returns "
        "tickets grouped by status (open/done) with PR links when shipped."
    )
    parameters = {
        "type": "object",
        "properties": {
            "days": {
                "type": "integer",
                "description": "Window in days (default 7, max 60).",
                "default": 7,
            },
        },
        "required": [],
    }

    def execute(self, db=None, days: int = 7, **kwargs) -> str:
        from ..db.models import BacklogTicket

        if db is None:
            return "(no db session)"
        days = max(1, min(int(days or 7), 60))
        cutoff = datetime.utcnow() - timedelta(days=days)

        tickets = (
            db.query(BacklogTicket)
            .filter(BacklogTicket.updated_at >= cutoff)
            .order_by(BacklogTicket.updated_at.desc())
            .limit(40)
            .all()
        )
        if not tickets:
            return f"(no backlog activity in last {days}d)"

        shipped: list[BacklogTicket] = []
        in_flight: list[BacklogTicket] = []
        new_open: list[BacklogTicket] = []
        for t in tickets:
            if t.board_status == "done":
                shipped.append(t)
            elif t.board_status == "doing":
                in_flight.append(t)
            else:
                new_open.append(t)

        out: list[str] = []
        if shipped:
            out.append("## shipped")
            for t in shipped[:10]:
                pr = f" → {t.pr_url}" if t.pr_url else ""
                out.append(f"- #{t.id} {t.text}{pr}")
        if in_flight:
            out.append("## in flight")
            for t in in_flight[:10]:
                claimer = f" [{t.claimed_by} picked up]" if t.claimed_by else ""
                out.append(f"- #{t.id} {t.text}{claimer}")
        if new_open:
            out.append("## new on backlog")
            for t in new_open[:10]:
                out.append(f"- #{t.id} {t.text}")
        return "\n".join(out)
