from .base import BaseTool
from ._returns import TodoReturn


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
        "not_yet. Returns a structured result {kind:'todo', status, summary}: "
        "status='created' for a new todo, status='duplicate' when the text "
        "already matched an open todo (the existing row was bumped, not "
        "doubled — tell Daniel it's already on the list)."
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

    def execute(self, db=None, text: str = "", due_date: str = "", **kwargs) -> TodoReturn:
        from datetime import datetime

        from ..services.todo_service import todo_service

        if db is None:
            return {"kind": "todo", "id": 0, "status": "invalid", "summary": "(no db session)"}
        text = (text or "").strip()
        if not text:
            return {"kind": "todo", "id": 0, "status": "invalid", "summary": "(text required)"}
        due = None
        if due_date:
            try:
                due = datetime.fromisoformat(due_date.replace("Z", "+00:00"))
            except ValueError:
                return {
                    "kind": "todo", "id": 0, "status": "invalid",
                    "summary": f"could not parse due_date '{due_date}' — use YYYY-MM-DD",
                }
        # todo_service.create dedups at cosine ≥0.85: a near-paraphrase of an
        # open todo bumps the existing row's mention_count instead of inserting
        # a dupe. mention_count>1 means we hit that path → status='duplicate'.
        t = todo_service.create(db, text=text, due_date=due)
        mc = t.mention_count or 1
        if mc > 1:
            return {
                "kind": "todo", "id": t.id, "status": "duplicate",
                "summary": f'already on the list — "{t.text}" (mention #{mc})',
                "context": {"matched_text": t.text, "mention_count": mc},
            }
        return {
            "kind": "todo", "id": t.id, "status": "created",
            "summary": f'added "{t.text}"',
            "context": {"matched_text": t.text},
        }


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
        "marked done by accident. Shortest match wins.\n"
        "Returns a structured result {kind:'todo', status, summary}:\n"
        "  status='closed'|'reopened'|'started' — the change landed.\n"
        "  status='already_in_state' — the todo was ALREADY in that state; "
        "nothing to do. Acknowledge it as already done/started — do NOT say "
        "you couldn't close it.\n"
        "  status='not_found' — no todo matched; surface the miss honestly.\n"
        "Call ONCE per intent. Do NOT retry with shorter or alternate "
        "substrings — if status='not_found', ask Daniel to clarify, don't loop."
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
    ) -> TodoReturn:
        from ..services.todo_service import todo_service

        if db is None:
            return {"kind": "todo", "id": 0, "status": "invalid", "summary": "(no db session)"}
        if state not in VALID_TODO_STATES:
            return {
                "kind": "todo", "id": 0, "status": "invalid",
                "summary": f"invalid state '{state}'; use not_yet | doing | done",
            }
        # Phase 2: match ANY todo (not only-open). This is what kills the
        # leetcode-class bug without the old 90s closed-this-turn fallback:
        # when a todo is already in the requested state we now return
        # status='already_in_state' instead of a free-text "(no match)".
        # The redundant shorter-substring variant call that broke seg 319
        # now lands on an unambiguous status the LLM can't misread as
        # failure. The react-loop dedup gate still short-circuits identical
        # args; this handles the variant-arg case.
        t, err = _find_todo_by_match(db, match, only_open=False)
        if err:
            return {
                "kind": "todo", "id": 0, "status": "not_found",
                "summary": f"no todo matching '{match}'",
                "context": {"matched_text": match},
            }
        current = t.state or ("done" if t.done else "not_yet")
        verb = {"done": "closed", "not_yet": "reopened", "doing": "started"}[state]
        if current == state:
            return {
                "kind": "todo", "id": t.id, "status": "already_in_state",
                "summary": f'"{t.text}" is already {state}',
                "context": {"matched_text": t.text, "from_state": current, "to_state": state},
            }
        todo_service.update(db, t.id, state=state)
        return {
            "kind": "todo", "id": t.id, "status": verb,
            "summary": f'{verb} "{t.text}"',
            "context": {"matched_text": t.text, "from_state": current, "to_state": state},
        }


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


class ShowDueWindowTool(BaseTool):
    """G3.9 loop-close: date-range recall. Filters open todos by their
    due_date relative to today/tomorrow/this_week, or surfaces overdues.
    Master prompt should call this when Daniel asks date-relative
    questions ("what's due tomorrow", "this week", "what's overdue").
    """
    name = "show_due_window"
    description = (
        "Show open todos due within a window. CALL when Daniel asks "
        "'what's due today', 'tomorrow', 'this week', or 'what's overdue'. "
        "Don't ad-lib from state_block — query the actual due_date col. "
        "Returns formatted list."
    )
    parameters = {
        "type": "object",
        "properties": {
            "range": {
                "type": "string",
                "enum": ["today", "tomorrow", "this_week", "overdue"],
                "description": "Which due-date window to filter.",
            },
        },
        "required": ["range"],
    }

    def execute(self, db=None, range: str = "today", **kwargs) -> str:
        from datetime import timedelta, timezone
        from ..common import local_now
        from ..db.models import Todo

        if db is None:
            return "(no db session)"
        # Day bounds in Daniel's LOCAL tz, converted to naive UTC to match
        # the storage convention. Plain utcnow() bounds made "due today"
        # return tomorrow's todos after ~5pm PT (audit 2026-06-10).
        local = local_now(db)

        def _utc(dt):
            return dt.astimezone(timezone.utc).replace(tzinfo=None)

        now = _utc(local)
        today_eod = _utc(local.replace(hour=23, minute=59, second=59, microsecond=0))
        today_start = _utc(local.replace(hour=0, minute=0, second=0, microsecond=0))
        tomorrow_local = (local + timedelta(days=1))
        tomorrow_start = _utc(tomorrow_local.replace(hour=0, minute=0, second=0, microsecond=0))
        tomorrow_eod = _utc(tomorrow_local.replace(hour=23, minute=59, second=59, microsecond=0))
        week_eod = _utc((local + timedelta(days=7)).replace(hour=23, minute=59, second=59, microsecond=0))

        q = db.query(Todo).filter(
            Todo.done.is_(False),
            Todo.deleted_at.is_(None),
            Todo.due_date.is_not(None),
        )

        if range == "today":
            q = q.filter(Todo.due_date <= today_eod, Todo.due_date >= today_start)
            label = "due today"
        elif range == "tomorrow":
            q = q.filter(Todo.due_date >= tomorrow_start, Todo.due_date <= tomorrow_eod)
            label = "due tomorrow"
        elif range == "this_week":
            q = q.filter(Todo.due_date >= now, Todo.due_date <= week_eod)
            label = "due this week"
        elif range == "overdue":
            q = q.filter(Todo.due_date < now)
            label = "overdue"
        else:
            return f"(invalid range '{range}' — expected today|tomorrow|this_week|overdue)"

        rows = q.order_by(Todo.due_date.asc()).limit(20).all()
        if not rows:
            return f"({label}: nothing)"
        lines = [f"{label}: {len(rows)} todo(s)"]
        for t in rows:
            due_str = t.due_date.strftime("%a %b %d") if t.due_date else "?"
            state_tag = {"not_yet": "[ ]", "doing": "[~]"}.get(t.state, "[ ]")
            lines.append(f"  {state_tag} \"{t.text}\" · {due_str}")
        return "\n".join(lines)


class ShowMyPlateTool(BaseTool):
    """G3.9 recall fluency tool. The state_block is always-on context,
    but it bloats the prompt to be fully verbose — this tool returns
    a richer, Alfred-formatted view ON DEMAND when Daniel asks recall
    questions like "what's on my plate", "what's primary", "what's
    left today".
    """
    name = "show_my_plate"
    description = (
        "Show Daniel's actionable plate: primary todo + top-ranked + "
        "counts + chain hints. CALL THIS WHEN Daniel asks 'what's on my "
        "plate', 'what's primary', 'what's left', 'what do i have', "
        "'what's open'. Do NOT make up the answer from memory — the "
        "todos table is the source of truth. Returns one block of text "
        "the user should see verbatim; reply with it directly + minimal "
        "framing."
    )
    parameters = {"type": "object", "properties": {}}

    def execute(self, db=None, **kwargs) -> str:
        if db is None:
            return "(no db session)"
        from ..services.todo_service import todo_service
        from ..db.models import Todo

        primary = todo_service.get_primary(db)
        open_todos = todo_service.list_open(db)
        non_primary = [t for t in open_todos if not t.is_primary]
        ranked = sorted(
            [t for t in non_primary if (t.sort_order or 0) > 0],
            key=lambda t: t.sort_order or 0,
        )
        unranked = [t for t in non_primary if (t.sort_order or 0) == 0]

        # G3.9 chain inline: build a quick chain_summary like /todos does
        # so per-row lines can carry "↗N" / "← from: X" without extra calls.
        chain_summary = todo_service.bulk_chain_summary(db) if hasattr(todo_service, "bulk_chain_summary") else {}

        def _chain_tail(t) -> str:
            meta = chain_summary.get(t.id) if isinstance(chain_summary, dict) else None
            if not meta:
                return ""
            bits = []
            ct = meta.get("children_total") or 0
            cd = meta.get("children_done") or 0
            if ct:
                bits.append(f"↗{ct}" + (f" ✓{cd}" if cd else ""))
            pid = meta.get("parent_id")
            ptext = meta.get("parent_text")
            if pid and ptext:
                bits.append(f"← from: \"{ptext[:40]}\"")
            return f"  [{' · '.join(bits)}]" if bits else ""

        def _mention_tail(t) -> str:
            mc = t.mention_count or 1
            return f" ×{mc}" if mc > 1 else ""

        lines = []
        total = len(open_todos)
        done_today = todo_service.list_done_today(db)
        lines.append(f"open: {total} · done today: {len(done_today)}")
        slot = 1
        if primary is not None:
            lines.append(
                f"#{slot} (primary): \"{primary.text}\" ({primary.state}){_mention_tail(primary)}{_chain_tail(primary)}"
            )
            slot += 1
        for t in ranked[:6]:
            lines.append(
                f"#{slot}: \"{t.text}\" ({t.state}){_mention_tail(t)}{_chain_tail(t)}"
            )
            slot += 1
        if unranked:
            lines.append(f"+ {len(unranked)} unranked (no manual position set yet)")
        return "\n".join(lines)


class ShowChainTool(BaseTool):
    """G3.9 recall tool — surfaces the full lineage thread for a todo
    by substring/cosine match. Use when Daniel asks 'what came from X',
    'show me the thread on Y', 'what's the chain for Z'."""
    name = "show_chain"
    description = (
        "Show the lineage thread for a todo — ancestors, the todo itself, "
        "descendants. Use when Daniel asks 'what came from X', 'show me "
        "the thread on Y', 'what's the chain'. Resolves the todo by "
        "substring match (shortest-match wins). Returns hierarchical text."
    )
    parameters = {
        "type": "object",
        "properties": {
            "match": {
                "type": "string",
                "description": "Substring identifying the todo to surface the chain for.",
            },
        },
        "required": ["match"],
    }

    def execute(self, db=None, match: str = "", **kwargs) -> str:
        if db is None:
            return "(no db session)"
        match = (match or "").strip()
        if not match:
            return "(match required)"
        from ..services.todo_service import todo_service
        todo, err = _find_todo_by_match(db, match, only_open=False)
        if todo is None:
            return err or f"(no todo for '{match}')"
        chain = todo_service.get_chain(db, todo.id)
        if chain is None:
            return f"(todo #{todo.id} not found)"

        # Ancestors come back deepest-first; render shallowest-first
        # so the thread reads top-down.
        ancestors = sorted(chain.get("ancestors") or [], key=lambda x: -x.get("depth", 0))
        descendants = sorted(chain.get("descendants") or [], key=lambda x: x.get("depth", 0))
        this = chain.get("this") or {}

        lines = [f"chain for \"{todo.text}\":"]
        if ancestors:
            for a in ancestors:
                t = a.get("todo") or {}
                indent = "  " * (a.get("depth", 1))
                state_tag = f"({t.get('state', '?')})"
                lines.append(f"{indent}← \"{t.get('text', '')}\" {state_tag}")
        else:
            lines.append("  (no ancestors — root)")
        lines.append(f"→ \"{this.get('text', '')}\" ({this.get('state', '?')}) ← here")
        if descendants:
            for d in descendants:
                t = d.get("todo") or {}
                indent = "  " * (d.get("depth", 1))
                state_tag = f"({t.get('state', '?')})"
                lines.append(f"{indent}↗ \"{t.get('text', '')}\" {state_tag}")
        else:
            lines.append("  (no descendants — leaf)")
        return "\n".join(lines)

