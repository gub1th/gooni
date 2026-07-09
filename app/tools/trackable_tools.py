"""Read-only Trackable chat tool (Slice 6). Logging stays router-driven
(the fitness handler writes entries in real time); the LLM needs the
read surface for "how's my cut going" / "what did whoop say"."""

from __future__ import annotations

from .base import BaseTool


class ReadTrackableTool(BaseTool):
    name = "read_trackable"
    description = (
        "Read Master's trackables — the generic measurement primitive "
        "(calories, protein, weight, substances, whoop, leetcode…). "
        "Empty name lists all definitions; a name returns that "
        "trackable's per-day values for the last N days. Use for 'how's "
        "the cut', 'what's my weight trend', 'whoop numbers'. Read-only."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Trackable name (empty = list all).",
                "default": "",
            },
            "days": {
                "type": "integer",
                "description": "Pivot window in days (default 7, max 60).",
                "default": 7,
            },
        },
        "required": [],
    }

    def execute(self, db=None, name: str = "", days: int = 7, **kwargs) -> str:
        from ..services import trackable_service

        if db is None:
            return "(no db session)"
        days = max(1, min(int(days or 7), 60))
        if not (name or "").strip():
            defs = trackable_service.list_all(db)
            if not defs:
                return "(no trackables)"
            return "\n".join(
                f"- {t.name} ({t.kind}"
                + (f", target {t.target:g}{' ' + t.unit if t.unit else ''}" if t.target is not None else "")
                + ")"
                for t in defs
            )
        t = trackable_service.get_by_name(db, name)
        if t is None:
            return f"(no trackable named {name!r})"
        pivot = trackable_service.pivot(db, t, days=days)
        if not pivot:
            return f"{t.name}: no entries in last {days}d"
        lines = [f"{t.name} ({t.kind}, last {days}d):"]
        for d in pivot:
            lines.append(f"  {d['date']}: {d['value']}")
        return "\n".join(lines)
