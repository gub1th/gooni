import os

from mem0 import MemoryClient

USER_ID = "daniel"


def _unwrap(raw) -> list[dict]:
    """Mem0 v2 returns either a bare list or {'results': [...]}. Normalize to list."""
    if isinstance(raw, dict):
        return raw.get("results", [])
    return raw or []


class MemoryService:
    def __init__(self):
        self.client = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))

    def add_exchange(self, user_message: str, assistant_reply: str) -> None:
        """Called after every chat turn. Mem0 auto-extracts facts/preferences."""
        try:
            self.client.add([
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": assistant_reply},
            ], user_id=USER_ID)
        except Exception as e:
            print(f"Memory add_exchange error: {e}")

    def add_memory(self, content: str) -> None:
        """Directly add a single memory (for tools, MCP, note memorize)."""
        try:
            self.client.add([{"role": "user", "content": content}], user_id=USER_ID)
        except Exception as e:
            print(f"Memory add_memory error: {e}")

    def build_memory_context(self, query: str) -> str:
        """Search Mem0 and format results for system prompt injection."""
        try:
            results = _unwrap(self.client.search(query, filters={"user_id": USER_ID}, limit=8))
            if not results:
                return ""
            lines = ["What Gooni knows about Daniel:"]
            for r in results:
                lines.append(f"- {r['memory']}")
            return "\n".join(lines)
        except Exception as e:
            print(f"Memory build_memory_context error: {e}")
            return ""

    def get_all(self) -> list[dict]:
        try:
            return _unwrap(self.client.get_all(filters={"user_id": USER_ID}))
        except Exception as e:
            print(f"Memory get_all error: {e}")
            return []

    def search(self, query: str, limit: int = 8) -> list[dict]:
        try:
            return _unwrap(self.client.search(query, filters={"user_id": USER_ID}, limit=limit))
        except Exception as e:
            print(f"Memory search error: {e}")
            return []

    def delete(self, memory_id: str) -> None:
        try:
            self.client.delete(memory_id=memory_id)
        except Exception as e:
            print(f"Memory delete error: {e}")

    def has_memories(self) -> bool:
        """Returns True if any memories exist (used for first-time Telegram detection)."""
        try:
            return bool(_unwrap(self.client.get_all(filters={"user_id": USER_ID})))
        except Exception as e:
            print(f"Memory has_memories error: {e}")
            return False


memory_service = MemoryService()
