from .base import BaseTool
from ._returns import MemoryReturn


class SaveMemoryTool(BaseTool):
    name = "save_memory"
    description = (
        "Save a stable fact about the user that should be remembered permanently. "
        "Use this for preferences, constraints, or personal details they reveal — "
        "'works night shifts', 'prefers concise answers', 'lives in LA'. "
        "Only use for stable, long-term facts — not transient updates or goal progress. "
        "Returns {kind:'memory', status, summary}: status='created' on success, "
        "status='invalid' if the content was empty."
    )
    parameters = {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The fact to remember, written as a clear statement about the user",
            },
        },
        "required": ["content"],
    }

    def execute(self, db=None, content: str = "", **kwargs) -> MemoryReturn:
        from ..services.memory_service import memory_service

        content = (content or "").strip()
        if not content:
            return {"kind": "memory", "id": 0, "status": "invalid", "summary": "(content required)"}
        m = memory_service.add_memory(content)
        if m is None:
            return {"kind": "memory", "id": 0, "status": "error", "summary": "memory write failed"}
        return {
            "kind": "memory", "id": m.id, "status": "created",
            "summary": "memory saved",
            "context": {"type": getattr(m, "type", "episode")},
        }
