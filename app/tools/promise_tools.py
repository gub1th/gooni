"""Read-only Promise chat tools (Slice 6). Writes stay router-driven —
creates glow for promote, complete/break auto-match from utterances —
so the LLM only needs a recall surface ("what's on my plate")."""

from __future__ import annotations

from .base import BaseTool


class ListPromisesTool(BaseTool):
    name = "list_promises"
    description = (
        "List Master's promises — the unified commitment primitive "
        "(one-shot chores, recurring habits, standing rules). Use for "
        "'what's on my plate', 'what am I on the hook for', 'did I keep "
        "X', or any commitment-recap question. Read-only."
    )
    parameters = {
        "type": "object",
        "properties": {
            "state": {
                "type": "string",
                "description": "active (default) | kept | broken | all",
                "default": "active",
            },
            "limit": {
                "type": "integer",
                "description": "Max rows (default 15).",
                "default": 15,
            },
        },
        "required": [],
    }

    def execute(self, db=None, state: str = "active", limit: int = 15, **kwargs) -> str:
        from ..db.models import Promise

        if db is None:
            return "(no db session)"
        limit = max(1, min(int(limit or 15), 50))
        q = db.query(Promise)
        if state and state != "all":
            q = q.filter(Promise.state == state)
        rows = (
            q.order_by(
                Promise.inferred_due.asc().nullslast(),
                Promise.created_at.desc(),
            )
            .limit(limit)
            .all()
        )
        if not rows:
            return f"(no {state} promises)"
        lines = []
        for p in rows:
            cad = p.cadence or "once"
            cad_tag = ""
            if cad == "n_per_week":
                cad_tag = f" [{p.cadence_target or '?'}x/wk]"
            elif cad != "once":
                cad_tag = f" [{cad}]"
            imp = " ★" if p.is_important else ""
            due = (
                f" (due {p.inferred_due.date().isoformat()})"
                if p.inferred_due else ""
            )
            lines.append(
                f"- [{p.state}] {p.summary or p.utterance}{cad_tag}{imp}{due}"
            )
        return "\n".join(lines)
