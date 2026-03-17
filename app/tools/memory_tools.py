from .base import BaseTool


class SaveMemoryTool(BaseTool):
    name = "save_memory"
    description = (
        "Save a stable fact about the user that should be remembered permanently. "
        "Use this for preferences, constraints, or personal details they reveal — "
        "'works night shifts', 'prefers concise answers', 'lives in LA'. "
        "Only use for stable, long-term facts — not transient updates or goal progress."
    )
    parameters = {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Short snake_case identifier e.g. 'workout_preference', 'dietary_restriction'",
            },
            "content": {
                "type": "string",
                "description": "The fact to remember, written as a clear statement about the user",
            },
        },
        "required": ["key", "content"],
    }

    def execute(self, db=None, key: str = "", content: str = "", **kwargs) -> str:
        from ..services.memory_service import memory_service

        memory_service.upsert_memory(
            {"key": key, "content": content, "confidence": 0.9},
            db,
        )
        return f"Saved: {key} = {content}"
