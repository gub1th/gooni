"""Capture-feature-gap tool. Called when Gooni recognizes Master is asking
for a capability that doesn't exist yet. Logs an item to the canonical
"Gooni Backlog" List (auto-created on first call). Master sees the
backlog grow under the unified Lists UI.

Switched from creating a Note row in a "Gooni Backlog" Space to creating
a ListItem under a List(type=backlog) — the unified List/ListItem model
replaces the old Space-as-bucket hack.
"""

from .base import BaseTool


class RequestFeatureTool(BaseTool):
    name = "request_feature"
    description = (
        "Log a capability gap as a feature request for Master to build. "
        "Call this when Master asks Gooni to do something not in CAPABILITIES "
        "(e.g. set reminders, send proactive messages, filter notes by date). "
        "Do NOT promise the task — only log it, then tell Master it's logged."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": (
                    "Short imperative title for the feature (max ~10 words). "
                    "Examples: 'Outbound time-based reminders via Telegram', "
                    "'Filter notes by date range', 'Voice-note transcription'."
                ),
            },
            "why": {
                "type": "string",
                "description": (
                    "One sentence describing what Master asked for and what's "
                    "missing today. Becomes the subtitle on the backlog item."
                ),
            },
        },
        "required": ["title", "why"],
    }

    def execute(
        self,
        db=None,
        title: str = "",
        why: str = "",
        source_note_id: int | None = None,
        **kwargs,
    ) -> str:
        from ..services.list_service import list_service

        title = (title or "").strip()
        why = (why or "").strip()
        if not title:
            return "request_feature: title required"
        if db is None:
            return "request_feature: no db session"

        backlog = list_service.get_or_create_backlog_list(db)
        item = list_service.add_item(
            backlog.id,
            text=title[:120],
            db=db,
            subtitle=why or None,
            source_note_id=source_note_id,
        )
        return f"Logged feature request #{item.id}: {title}"


feature_request_tool = RequestFeatureTool()
