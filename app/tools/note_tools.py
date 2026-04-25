from .base import BaseTool


class SearchNotesTool(BaseTool):
    name = "search_notes"
    description = (
        "Semantic search over Daniel's notes. Use whenever Daniel references "
        "something he wrote, asks 'what did I say about X', wants details "
        "from a past note, or you need context that isn't in the active "
        "note or conversation history. Notes are Daniel's writing surface — "
        "many things he believes or decided live there. Don't ask permission, "
        "just search. Returns up to 5 matching note titles + snippets."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Topic or phrase to search for (natural language).",
            },
            "limit": {
                "type": "integer",
                "description": "Max notes to return (default 5, max 10).",
                "default": 5,
            },
        },
        "required": ["query"],
    }

    def execute(self, db=None, query: str = "", limit: int = 5, **kwargs) -> str:
        from ..services.note_service import note_service

        if db is None:
            return "(no db session)"
        query = (query or "").strip()
        if not query:
            return "(empty query)"
        limit = max(1, min(int(limit or 5), 10))
        notes = note_service.search_by_query(query, limit, db)
        if not notes:
            return f"(no notes matched '{query}')"
        lines = []
        for n in notes:
            title = (n.title or "Untitled").strip()
            # Strip HTML for the snippet so the LLM gets readable text.
            from ..services.note_service import NoteService
            text = NoteService._strip_html(n.content or "")
            snippet = text[:300].replace("\n", " ")
            lines.append(f"#{n.id} {title}\n  {snippet}")
        return "\n\n".join(lines)
