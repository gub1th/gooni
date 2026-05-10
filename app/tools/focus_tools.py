from .base import BaseTool


VALID_FOCUS_STATUSES = ("committed", "pending", "someday")


class AddFocusTool(BaseTool):
    name = "add_focus"
    description = (
        "Create a new focus on Daniel's dashboard. A focus is a long-running "
        "thing he's committed to or considering, with an endgoal that defines "
        "'done'. Use when Daniel says 'I want to commit to X', 'a new focus "
        "for me is X', 'I'm thinking about working on X'. Higher friction "
        "than a todo — only create when the language matches focus-shaped "
        "intent."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Short focus label (e.g. 'Ship Gooni v2').",
            },
            "endgoal": {
                "type": "string",
                "description": "What 'done' looks like — concrete enough to recognize completion.",
            },
            "status": {
                "type": "string",
                "enum": list(VALID_FOCUS_STATUSES),
                "description": "Engagement state: committed (actively working), pending (warming up), someday (parked). Default committed.",
                "default": "committed",
            },
        },
        "required": ["name", "endgoal"],
    }

    def execute(
        self,
        db=None,
        name: str = "",
        endgoal: str = "",
        status: str = "committed",
        **kwargs,
    ) -> str:
        from ..services.focus_service import focus_service

        if db is None:
            return "(no db session)"
        name = (name or "").strip()
        endgoal = (endgoal or "").strip()
        if not name or not endgoal:
            return "(name and endgoal required)"
        if status not in VALID_FOCUS_STATUSES:
            return f"(invalid status '{status}'; use committed | pending | someday)"
        f = focus_service.create(
            db,
            text=name,
            endgoal=endgoal,
            committed=(status == "committed"),
            status=status,
        )
        return f"added focus #{f.id}: {f.text} ({status})"


class ListFocusesTool(BaseTool):
    name = "list_focuses"
    description = (
        "List Daniel's active focuses (committed + pending + someday). Use "
        "when he asks 'what am I working on', 'what's my focus', or before "
        "suggesting he take on something new."
    )
    parameters = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Max focuses to return (default 10, max 20).",
                "default": 10,
            },
        },
    }

    def execute(self, db=None, limit: int = 10, **kwargs) -> str:
        from ..services.focus_service import focus_service

        if db is None:
            return "(no db session)"
        limit = max(1, min(int(limit or 10), 20))
        rows = focus_service.list_active(db)[:limit]
        if not rows:
            return "(no active focuses)"
        lines = []
        for f in rows:
            status = f.status or ("committed" if f.committed else "someday")
            endgoal = f" → {f.endgoal}" if f.endgoal else ""
            lines.append(f"#{f.id} [{status}] {f.text}{endgoal}")
        return "\n".join(lines)
