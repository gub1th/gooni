"""Capture-feature-gap tool. Called when Gooni recognizes Master is asking
for capability that doesn't exist yet. Logs a Note in the auto-created
"Gooni Backlog" space — zero schema, reuses existing notes infra. Master
sees the backlog grow in his sidebar like any other space.
"""

from .base import BaseTool


BACKLOG_SPACE_NAME = "Gooni Backlog"
BACKLOG_SPACE_EMOJI = "🛠"


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
                    "missing today. Will be the body of the backlog note."
                ),
            },
        },
        "required": ["title", "why"],
    }

    def execute(self, db=None, title: str = "", why: str = "", **kwargs) -> str:
        from ..db.models import Note, Space
        from datetime import datetime

        title = (title or "").strip()
        why = (why or "").strip()
        if not title:
            return "request_feature: title required"

        if db is None:
            return "request_feature: no db session"

        space = (
            db.query(Space)
            .filter(Space.name == BACKLOG_SPACE_NAME)
            .first()
        )
        if not space:
            space = Space(name=BACKLOG_SPACE_NAME, emoji=BACKLOG_SPACE_EMOJI)
            db.add(space)
            db.commit()
            db.refresh(space)

        body = (
            f"<p>{why}</p>"
            if why else f"<p>(captured by Gooni; no detail)</p>"
        )
        note = Note(
            title=title[:120],
            content=body,
            space_id=space.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(note)
        db.commit()
        db.refresh(note)
        return f"Logged feature request #{note.id}: {title}"


feature_request_tool = RequestFeatureTool()
