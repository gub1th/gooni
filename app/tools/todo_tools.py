from .base import BaseTool


VALID_TODO_STATES = ("not_yet", "doing", "done")


def _find_todo_by_match(db, match: str, only_open: bool = False):
    """Substring match on Todo.text, case-insensitive. Returns (todo, error_msg)."""
    from ..db.models import Todo

    match_l = (match or "").lower().strip()
    if not match_l:
        return None, "(empty match string)"
    q = db.query(Todo)
    if only_open:
        q = q.filter(Todo.done.is_(False))
    candidates = q.order_by(Todo.sort_order, Todo.id).all()
    hits = [t for t in candidates if match_l in (t.text or "").lower()]
    if not hits:
        return None, f"(no todo matching '{match}')"
    # Shortest match wins — prefers the most specific item.
    hits.sort(key=lambda t: len(t.text or ""))
    return hits[0], None


class AddTodoTool(BaseTool):
    name = "add_todo"
    description = (
        "Add a todo to Daniel's dashboard. Use when he says 'remind me to X', "
        "'add a todo for X', 'I need to do X today/tomorrow'. Todos carry a "
        "3-state lifecycle (not_yet → doing → done); new todos start at "
        "not_yet. Returns the todo id + text."
    )
    parameters = {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Todo text (e.g. 'review PR #42', 'water the plants').",
            },
            "due_date": {
                "type": "string",
                "description": "Optional ISO date (YYYY-MM-DD) or datetime.",
            },
        },
        "required": ["text"],
    }

    def execute(self, db=None, text: str = "", due_date: str = "", **kwargs) -> str:
        from datetime import datetime

        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        text = (text or "").strip()
        if not text:
            return "(text required)"
        due = None
        if due_date:
            try:
                due = datetime.fromisoformat(due_date.replace("Z", "+00:00"))
            except ValueError:
                return f"(could not parse due_date '{due_date}' — use YYYY-MM-DD)"
        t = todo_service.create(db, text=text, due_date=due)
        return f"added todo #{t.id}: {t.text}"


class ListTodosTool(BaseTool):
    name = "list_todos"
    description = (
        "List Daniel's open todos. Use when he asks 'what's on my list', "
        "'what do I have today', or before claiming work is done. Default "
        "excludes completed items."
    )
    parameters = {
        "type": "object",
        "properties": {
            "include_done": {
                "type": "boolean",
                "description": "Include completed todos (default False).",
                "default": False,
            },
            "limit": {
                "type": "integer",
                "description": "Max items to return (default 20, max 50).",
                "default": 20,
            },
        },
    }

    def execute(
        self,
        db=None,
        include_done: bool = False,
        limit: int = 20,
        **kwargs,
    ) -> str:
        from ..db.models import Todo

        if db is None:
            return "(no db session)"
        limit = max(1, min(int(limit or 20), 50))
        q = db.query(Todo)
        if not include_done:
            q = q.filter(Todo.done.is_(False))
        rows = q.order_by(Todo.sort_order, Todo.id).limit(limit).all()
        if not rows:
            return "(no todos)"
        lines = []
        for t in rows:
            state = t.state or ("done" if t.done else "not_yet")
            mark = {"not_yet": "[ ]", "doing": "[~]", "done": "[x]"}.get(state, "[ ]")
            lines.append(f"#{t.id} {mark} {t.text}")
        return "\n".join(lines)


class SetTodoStateTool(BaseTool):
    name = "set_todo_state"
    description = (
        "Change a todo's state by substring match. Todos have 3 states: "
        "'not_yet' (not started), 'doing' (in progress), 'done' (complete). "
        "Use 'doing' when Daniel says 'starting X', 'done' when he says "
        "'finished X' / 'done with X', 'not_yet' to reopen something he "
        "marked done by accident. Shortest-match wins."
    )
    parameters = {
        "type": "object",
        "properties": {
            "match": {
                "type": "string",
                "description": "Case-insensitive substring of the todo text.",
            },
            "state": {
                "type": "string",
                "enum": list(VALID_TODO_STATES),
                "description": "New state: not_yet | doing | done.",
            },
        },
        "required": ["match", "state"],
    }

    def execute(
        self,
        db=None,
        match: str = "",
        state: str = "",
        **kwargs,
    ) -> str:
        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        if state not in VALID_TODO_STATES:
            return f"(invalid state '{state}'; use not_yet | doing | done)"
        # When marking done, allow matching already-done items only if the
        # caller is reopening — but for state=done we want only-open.
        only_open = state == "done"
        t, err = _find_todo_by_match(db, match, only_open=only_open)
        if err:
            return err
        todo_service.update(db, t.id, state=state)
        mark = {"not_yet": "[ ]", "doing": "[~]", "done": "[x]"}[state]
        return f"{mark} {t.text}"
