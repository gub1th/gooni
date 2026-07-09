from datetime import datetime

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


class AddNoteTool(BaseTool):
    name = "add_note"
    description = (
        "Create a new note in Gooni. Use when Daniel says 'jot this down', "
        "'save a note about X', dictates a longer thought, or you need to "
        "capture something too long for a memory. Pass tags to organize "
        "(spaces are gone — tags own organization). "
        "Returns the created note id + title."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short note title.",
            },
            "content": {
                "type": "string",
                "description": "Note body (plain text or HTML).",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Free-form lowercase labels (e.g. ['ideas', 'gooni']).",
            },
        },
        "required": ["title", "content"],
    }

    def execute(
        self,
        db=None,
        title: str = "",
        content: str = "",
        tags: list | None = None,
        **kwargs,
    ) -> str:
        import json as _json

        from ..db.models import Note
        from ..serializers import _excerpt_from_html

        if db is None:
            return "(no db session)"
        title = (title or "").strip()
        content = (content or "").strip()
        if not title and not content:
            return "(title or content required)"
        clean_tags = sorted({
            t.strip().lower()[:60] for t in (tags or [])
            if isinstance(t, str) and t.strip()
        } | {"from-chat"})
        note = Note(
            title=title,
            content=content,
            excerpt=_excerpt_from_html(content),
            tags=_json.dumps(clean_tags),
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(note)
        db.commit()
        db.refresh(note)
        # Embed immediately — the HTTP save path schedules this as a
        # background task, but this tool bypasses that route entirely.
        # Without it, notes Gooni creates are invisible to its own
        # search_notes cosine pass ("save a note about X" → "what did I
        # say about X" missed). update_embedding opens its own session
        # and swallows failures.
        from ..services.note_service import note_service
        note_service.update_embedding(note.id)
        return f"Created note #{note.id}: {note.title or '(untitled)'} (tags: {', '.join(clean_tags)})."


class FindNoteTool(BaseTool):
    name = "find_note"
    description = (
        "Find recent notes by case-insensitive substring match on title or "
        "body. Cheaper than search_notes when Daniel remembers a specific "
        "phrase or word from a recent note. Use search_notes for semantic / "
        "'what did I say about X' queries."
    )
    parameters = {
        "type": "object",
        "properties": {
            "match": {
                "type": "string",
                "description": "Case-insensitive substring to look for.",
            },
            "limit": {
                "type": "integer",
                "description": "Max hits to return (default 5, max 10).",
                "default": 5,
            },
        },
        "required": ["match"],
    }

    def execute(self, db=None, match: str = "", limit: int = 5, **kwargs) -> str:
        from ..db.models import Note
        from ..services.note_service import NoteService

        if db is None:
            return "(no db session)"
        match_l = (match or "").lower().strip()
        if not match_l:
            return "(empty match string)"
        limit = max(1, min(int(limit or 5), 10))
        scan = (
            db.query(Note)
            .order_by(Note.updated_at.desc())
            .limit(100)
            .all()
        )
        hits = []
        for n in scan:
            title = (n.title or "").lower()
            plain = NoteService._strip_html(n.content or "").lower()
            if match_l in title or match_l in plain:
                hits.append(n)
                if len(hits) >= limit:
                    break
        if not hits:
            return f"(no recent note matching '{match}')"
        lines = []
        for n in hits:
            snippet = NoteService._strip_html(n.content or "")[:120].replace("\n", " ")
            lines.append(f"#{n.id} {n.title or '(untitled)'} — {snippet}")
        return "\n".join(lines)


class ReadNoteTool(BaseTool):
    name = "read_note"
    description = (
        "Read the full body of a note by id (HTML stripped to plain text). "
        "Use after find_note / search_notes when Daniel asks for the full "
        "contents of a specific note."
    )
    parameters = {
        "type": "object",
        "properties": {
            "note_id": {
                "type": "integer",
                "description": "Numeric note id from find_note or search_notes.",
            },
        },
        "required": ["note_id"],
    }

    def execute(self, db=None, note_id: int = 0, **kwargs) -> str:
        from ..db.models import Note
        from ..services.note_service import NoteService

        if db is None:
            return "(no db session)"
        try:
            nid = int(note_id)
        except (TypeError, ValueError):
            return "(note_id must be an integer)"
        n = db.query(Note).filter(Note.id == nid).first()
        if not n:
            return f"(note #{nid} not found)"
        body = NoteService._strip_html(n.content or "").strip() or "(empty)"
        return f"#{n.id} {n.title or '(untitled)'}\n{body}"


class ListRecentNotesTool(BaseTool):
    name = "list_recent_notes"
    description = (
        "List Daniel's most recently updated notes across all spaces. Use "
        "when he asks 'what was I writing about yesterday' or wants to "
        "orient on recent work without a specific query."
    )
    parameters = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Max notes to return (default 5, max 15).",
                "default": 5,
            },
        },
    }

    def execute(self, db=None, limit: int = 5, **kwargs) -> str:
        from ..db.models import Note

        if db is None:
            return "(no db session)"
        limit = max(1, min(int(limit or 5), 15))
        rows = (
            db.query(Note)
            .order_by(Note.updated_at.desc())
            .limit(limit)
            .all()
        )
        if not rows:
            return "(no notes yet)"
        lines = []
        for n in rows:
            preview = (n.excerpt or "").strip()
            preview = preview[:120].replace("\n", " ")
            lines.append(f"#{n.id} {n.title or '(untitled)'} — {preview}")
        return "\n".join(lines)
