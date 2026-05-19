from .base import BaseTool


VALID_TODO_STATES = ("not_yet", "doing", "done")


def _find_todo_by_match(db, match: str, only_open: bool = False):
    """Substring match on Todo.text, case-insensitive. Returns (todo, error_msg)."""
    from ..db.models import Todo

    match_l = (match or "").lower().strip()
    if not match_l:
        return None, "(empty match string)"
    q = db.query(Todo).filter(Todo.deleted_at.is_(None))
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
        q = db.query(Todo).filter(Todo.deleted_at.is_(None))
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


# ── G1 groom-mutation tools — auto-act + soft-delete + 24h undo ────────
# Pattern (per plan design principle #1): execute immediately on intent
# match, soft-delete is reversible for 24h via undo_last_todo_op, ack
# lists the text strings so wrong matches are spottable. No confirm-step
# pre-gate — undo window IS the safety.


_GROOM_COSINE_FLOOR = 0.55


def _cosine_match_open_todos(
    db, query_text: str, floor: float = _GROOM_COSINE_FLOOR, limit: int = 20
):
    """Return [(todo, score), ...] for OPEN todos cosine-matching the
    query text. Tuple-walk on (id, text, embedding) to avoid hydrating
    every row's full body.
    """
    from ..db.models import Todo
    from ..services.list_service import list_service, _cosine

    qvec = list_service._embed_item_text(query_text)
    if not qvec:
        return []
    rows = (
        db.query(Todo.id, Todo.text, Todo.subtitle, Todo.embedding)
        .filter(Todo.done.is_(False), Todo.deleted_at.is_(None))
        .all()
    )
    out: list[tuple] = []
    for tid, text, subtitle, emb_raw in rows:
        if not emb_raw:
            continue
        try:
            import json as _json
            evec = _json.loads(emb_raw)
        except Exception:
            continue
        s = _cosine(qvec, evec)
        if s >= floor:
            out.append((tid, text, subtitle, s))
    out.sort(key=lambda r: r[3], reverse=True)
    return out[:limit]


class GroomTodosTool(BaseTool):
    name = "groom_todos"
    description = (
        "Soft-delete todos that cosine-match a free-form grooming intent. "
        "Use when Daniel says 'delete all the X stuff', 'kill the trim-list "
        "todos', 'clean up the dupes about Y'. Executes immediately — 24h "
        "undo via 'undo' / 'reopen' utterance. Ack must list the deleted "
        "text strings so Daniel can spot wrong matches; the lifespan "
        "sweeper hard-purges past 24h. NEVER use this for state changes "
        "(use set_todo_state) or single named todos (use rename_todo when "
        "in doubt)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "description": (
                    "Free-form grooming target — e.g. 'trim list-title "
                    "injection cluster', 'duplicate forge prep todos', "
                    "'old internal cleanup items'. Cosine-matched against "
                    "open todos."
                ),
            },
            "min_similarity": {
                "type": "number",
                "description": (
                    "Optional cosine floor (0..1, default 0.55). Raise "
                    "if Daniel says 'only the exact ones' / similar."
                ),
            },
        },
        "required": ["intent"],
    }

    def execute(
        self, db=None, intent: str = "", min_similarity: float = 0.0, **kwargs
    ) -> str:
        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        intent = (intent or "").strip()
        if not intent:
            return "(intent required)"
        floor = max(0.0, min(float(min_similarity or 0.0), 1.0)) or _GROOM_COSINE_FLOOR
        matches = _cosine_match_open_todos(db, intent, floor=floor, limit=20)
        if not matches:
            return f"(no open todos match '{intent}' at cosine >= {floor:.2f})"
        ids = [m[0] for m in matches]
        deleted = todo_service.bulk_soft_delete(db, ids)
        if not deleted:
            return f"(matched {len(matches)} but none soft-deleted; already gone?)"
        # Render text strings (Alfred voice — verb-led, no preface, no ids).
        # Includes the cosine score in compact form so Daniel can eyeball
        # whether the threshold was too loose.
        del_set = set(deleted)
        rendered = ", ".join(
            f"\"{text}\"" for (tid, text, _sub, _s) in matches if tid in del_set
        )
        return f"killed {len(deleted)}. {rendered}. undo if wrong."


class MergeTodosTool(BaseTool):
    name = "merge_todos"
    description = (
        "Merge N todos into one. Cosine-resolve primary_match and each "
        "merged_match against open todos; concat merged text into primary "
        "subtitle (newline-joined with '+ ' prefix), soft-delete merged "
        "rows. Use when Daniel says 'merge X and Y', 'these are the same "
        "thing — combine them'. Auto-acts, 24h undo. Primary text stays."
    )
    parameters = {
        "type": "object",
        "properties": {
            "primary_match": {
                "type": "string",
                "description": "Substring identifying the todo to KEEP.",
            },
            "merged_matches": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "List of substrings identifying the todos to absorb "
                    "into primary. Each resolves via shortest-substring "
                    "match. Primary itself never appears here."
                ),
            },
        },
        "required": ["primary_match", "merged_matches"],
    }

    def execute(
        self,
        db=None,
        primary_match: str = "",
        merged_matches: list = None,
        **kwargs,
    ) -> str:
        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        primary, err = _find_todo_by_match(db, primary_match, only_open=True)
        if err:
            return f"(primary: {err})"
        merged_ids: list[int] = []
        not_found: list[str] = []
        for m in merged_matches or []:
            t, err = _find_todo_by_match(db, m, only_open=True)
            if err or t is None:
                not_found.append(m)
                continue
            if t.id == primary.id:
                # Skip self-match silently — common LLM mis-render.
                continue
            merged_ids.append(t.id)
        if not merged_ids:
            return f"(no merge candidates; tried {merged_matches}; not found: {not_found})"
        updated = todo_service.merge(db, primary.id, merged_ids)
        if updated is None:
            return "(merge failed)"
        return (
            f"merged {len(merged_ids)} into \"{primary.text}\". "
            f"undo if wrong."
        )


class RenameTodoTool(BaseTool):
    name = "rename_todo"
    description = (
        "Rename a todo by substring match. Use when Daniel says 'rename X "
        "to Y' / 'change that todo to say Y'. Shortest-match wins. No "
        "soft-delete — straight update; legacy text not preserved. If "
        "wrong todo got renamed, Daniel asks again with the right match."
    )
    parameters = {
        "type": "object",
        "properties": {
            "match": {
                "type": "string",
                "description": "Substring identifying the todo to rename.",
            },
            "new_text": {
                "type": "string",
                "description": "Replacement text.",
            },
        },
        "required": ["match", "new_text"],
    }

    def execute(
        self, db=None, match: str = "", new_text: str = "", **kwargs
    ) -> str:
        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        new_text = (new_text or "").strip()
        if not new_text:
            return "(new_text required)"
        t, err = _find_todo_by_match(db, match, only_open=True)
        if err:
            return err
        old = t.text
        todo_service.update(db, t.id, text=new_text)
        return f"renamed. \"{old}\" → \"{new_text}\"."


class UndoLastTodoOpTool(BaseTool):
    name = "undo_last_todo_op"
    description = (
        "Reverse the most recent destructive todo op within the 24h window. "
        "Use when Daniel says 'undo', 'undo that', 'reopen those', 'wrong "
        "match'. Restores the soft-deleted todos (most-recent batch). If "
        "the window expired, surfaces that honestly — never silently fails."
    )
    parameters = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": (
                    "Max number of tombstones to restore (default 20). "
                    "Caps the blast radius if Daniel says 'undo' after "
                    "a bulk delete he actually wanted."
                ),
                "default": 20,
            },
        },
    }

    def execute(self, db=None, limit: int = 20, **kwargs) -> str:
        from datetime import datetime, timedelta
        from ..services.todo_service import todo_service

        if db is None:
            return "(no db session)"
        limit = max(1, min(int(limit or 20), 50))
        # Look at last 5 minutes by default — what feels like "the last
        # thing I did" in chat. If nothing there, fall back to the full
        # 24h window. Avoids restoring an old soft-delete from yesterday
        # when Daniel said "undo" meaning the current turn.
        recent_cutoff = datetime.utcnow() - timedelta(minutes=5)
        rows = todo_service.list_recently_deleted(db, since=recent_cutoff)
        if not rows:
            rows = todo_service.list_recently_deleted(db)
        if not rows:
            return "(nothing to undo in the last 24h)"
        restored: list[str] = []
        for r in rows[:limit]:
            t = todo_service.undelete(db, r.id)
            if t is not None:
                restored.append(t.text)
        if not restored:
            return "(undo window expired on those — past 24h)"
        rendered = ", ".join(f"\"{x}\"" for x in restored)
        return f"restored {len(restored)}. {rendered}."
