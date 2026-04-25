from .base import BaseTool


class MarkFocusActivityTool(BaseTool):
    name = "mark_focus_activity"
    description = (
        "Mark a focus as touched today — bumps its last_activity_at to now. "
        "Use whenever Daniel mentions making progress on something, or his "
        "message clearly relates to one of his active focuses (listed in the "
        "system context). The focus list lives under 'Daniel's active focuses' "
        "in this conversation's context. Pass the exact focus name from that "
        "list (case-insensitive substring match also works). Don't ask "
        "permission — just call it when the signal is there."
    )
    parameters = {
        "type": "object",
        "properties": {
            "focus_name": {
                "type": "string",
                "description": "Name of the focus to heartbeat. Use the exact "
                "name from the active focuses list in context.",
            },
        },
        "required": ["focus_name"],
    }

    def execute(self, db=None, focus_name: str = "", **kwargs) -> str:
        from ..services.focus_service import focus_service

        if db is None:
            return "(no db session)"
        focus = focus_service.find_by_name(db, focus_name)
        if not focus:
            return f"(no focus matching '{focus_name}')"
        focus_service.mark_activity(db, focus.id)
        return f"♥ marked '{focus.name}' as touched today"
