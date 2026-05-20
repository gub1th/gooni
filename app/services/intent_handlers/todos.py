"""Todo routing — dispatches extracted todo actions by `kind`.

G1.1 (post-eval-segment-280): extract_signals now emits `kind` per todo
action (create | delete | complete | merge) so the router can dispatch
destructive intents at extraction time. Pre-G1.1, "kill X" / "close Y"
got paraphrased into NEW create rows ("stop X", "move Y to done") that
doubled the pile — the failure mode the eval segment caught.

Chat-surface tools (`groom_todos`, `set_todo_state`, `merge_todos`)
remain as LLM-callable fallbacks for ad-hoc grooming when the extractor
underfires.

Cosine match floors (per kind):
  create.dedup: 0.85 (must be near-paraphrase to merge)
  delete:       0.55 (same as GroomTodosTool; free-form grooming-shape)
  complete:     0.60 (stricter; completion is more specific)
  merge:        0.55 on each of (match, merge_into)

Trace events:
  router:todo               — create succeeded
  router:todo_dedup         — create paraphrase hit existing open todo
  router:todo_killed        — delete succeeded
  router:todo_completed     — complete succeeded
  router:todo_merged        — merge succeeded
  router:todo_no_match      — destructive action found no matching open todo
"""

from __future__ import annotations

from datetime import datetime, timedelta


DEDUP_THRESHOLD = 0.85
DELETE_FLOOR = 0.55
COMPLETE_FLOOR = 0.60
MERGE_FLOOR = 0.55


_DUE_HINTS = {
    "tonight": ("today_eod", None),
    "today": ("today_eod", None),
    "tomorrow": ("plus_days", 1),
    "this week": ("plus_days", 7),
}


def _parse_due(hint):
    if not hint:
        return None
    h = hint.strip().lower()
    rule = _DUE_HINTS.get(h)
    if not rule:
        return None
    kind, arg = rule
    now = datetime.utcnow()
    if kind == "today_eod":
        return now.replace(hour=23, minute=59, second=0, microsecond=0)
    if kind == "plus_days" and isinstance(arg, int):
        return (now + timedelta(days=arg)).replace(
            hour=23, minute=59, second=0, microsecond=0
        )
    return None


def _find_open_duplicate(sess, vec, todo_service):
    """Cosine-match candidate against open todos for CREATE-side dedup.
    Returns (Todo, score) or (None, 0.0). Tuple-walks to avoid hydrating
    every open todo row."""
    from ..list_service import _cosine, list_service

    open_todos = todo_service.list_open(sess)
    best = None
    best_score = 0.0
    for t in open_todos:
        emb = list_service._embed_item_text(t.text)
        if not emb:
            continue
        score = _cosine(vec, emb)
        if score >= DEDUP_THRESHOLD and score > best_score:
            best = t
            best_score = score
    return best, best_score


def _cosine_top_open(db, query_text: str, floor: float):
    """Top open-todo match for query_text at given cosine floor.
    Returns (todo_id, text, score) or None. Wraps the chat-tool's helper
    so router-side dispatch + chat-tool grooming share the same match
    semantics — diverging them would be a silent bug factory."""
    from ...tools.todo_tools import _cosine_match_open_todos

    matches = _cosine_match_open_todos(db, query_text, floor=floor, limit=1)
    if not matches:
        return None
    tid, text, _sub, score = matches[0]
    return (tid, text, score)


def _safe_trace(ctx, name: str, label: str, args: dict) -> None:
    if not ctx.on_tool_call:
        return
    try:
        ctx.on_tool_call(name, label=label, args=args)
    except Exception as e:
        print(f"[todos handler] trace hook error: {e}")


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return

    from ..todo_service import todo_service

    for it in items:
        kind = (it.get("kind") or "create").lower()
        try:
            if kind == "create":
                _handle_create(it, ctx, result, todo_service)
            elif kind == "delete":
                _handle_delete(it, ctx, result, todo_service)
            elif kind == "complete":
                _handle_complete(it, ctx, result, todo_service)
            elif kind == "merge":
                _handle_merge(it, ctx, result, todo_service)
            # Unknown kinds dropped silently — normalize step already
            # validates, so this only catches future-kind drift.
        except Exception as e:
            print(f"[todos handler] {kind} error: {e}")
            continue


def _handle_create(it, ctx, result, todo_service) -> None:
    text = (it.get("text") or "").strip()
    if not text:
        return
    due_at = _parse_due(it.get("due_hint"))

    from ..list_service import list_service

    vec = list_service._embed_item_text(text)
    if vec:
        existing, score = _find_open_duplicate(ctx.db, vec, todo_service)
        if existing is not None:
            _safe_trace(
                ctx,
                "router:todo_dedup",
                f"Todo dedup hit (cosine={score:.2f})",
                {"new": text, "matched": existing.text, "id": existing.id},
            )
            return

    todo = todo_service.create(
        ctx.db,
        text=text,
        due_date=due_at,
        source_note_id=ctx.source_note_id,
    )
    result.captured_todos.append({"text": text, "todo_id": todo.id})
    result.tools_used.append("router:todo")
    _safe_trace(
        ctx,
        "router:todo",
        "Captured todo",
        {"text": text, "due_hint": it.get("due_hint"), "todo_id": todo.id},
    )


def _handle_delete(it, ctx, result, todo_service) -> None:
    match = (it.get("match") or "").strip()
    if not match:
        return
    hit = _cosine_top_open(ctx.db, match, floor=DELETE_FLOOR)
    if not hit:
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Todo delete no-match for '{match}'",
            {"kind": "delete", "match": match, "floor": DELETE_FLOOR},
        )
        result.failed_todo_actions.append({"kind": "delete", "match": match})
        return
    tid, text, score = hit
    deleted = todo_service.bulk_soft_delete(ctx.db, [tid])
    if not deleted:
        return
    result.killed_todos.append({"text": text, "todo_id": tid})
    result.tools_used.append("router:todo_killed")
    _safe_trace(
        ctx,
        "router:todo_killed",
        f"Killed todo (cosine={score:.2f})",
        {"match": match, "text": text, "id": tid},
    )


def _handle_complete(it, ctx, result, todo_service) -> None:
    match = (it.get("match") or "").strip()
    if not match:
        return
    hit = _cosine_top_open(ctx.db, match, floor=COMPLETE_FLOOR)
    if not hit:
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Todo complete no-match for '{match}'",
            {"kind": "complete", "match": match, "floor": COMPLETE_FLOOR},
        )
        result.failed_todo_actions.append({"kind": "complete", "match": match})
        return
    tid, text, score = hit

    # G3.5: complete kind can carry closure_note + spawned follow-ups.
    # Use close_with_outcome instead of bare update() so the closure_note
    # lands on the Todo + spawned_from edges get wired in one transaction.
    closure_note = (it.get("closure_note") or "").strip() or None
    spawned = it.get("spawned") or []

    if closure_note or spawned:
        out = todo_service.close_with_outcome(
            ctx.db,
            tid,
            closure_note=closure_note,
            spawned=spawned,
        )
        if out is None:
            return
        result.completed_todos.append(
            {
                "text": text,
                "todo_id": tid,
                "closure_note": closure_note,
            }
        )
        result.tools_used.append("router:todo_completed")
        _safe_trace(
            ctx,
            "router:todo_completed",
            f"Completed todo (cosine={score:.2f}) w/ outcome+{len(spawned)} spawn",
            {
                "match": match,
                "text": text,
                "id": tid,
                "closure_note": closure_note,
                "spawned_count": len(spawned),
            },
        )
        # Surface spawned children in captured_todos so the ack composer
        # + just_extracted_block can render them with real ids. Each
        # carries spawned_from_id pointing back to the parent.
        for child_serial in out.get("spawned", []):
            result.captured_todos.append(
                {
                    "text": child_serial.get("text"),
                    "todo_id": child_serial.get("id"),
                    "spawned_from_id": tid,
                    "spawned_from_text": text,
                }
            )
            result.tools_used.append("router:todo_spawned")
            _safe_trace(
                ctx,
                "router:todo_spawned",
                f"Spawned follow-up todo from #{tid}",
                {
                    "parent_id": tid,
                    "child_id": child_serial.get("id"),
                    "child_text": child_serial.get("text"),
                },
            )
        return

    # No closure metadata — bare complete via the existing update() path
    # so the existing behavior (backlog ticket auto-sync, primary clear)
    # stays intact. This is the common case for terse closes.
    todo = todo_service.update(ctx.db, tid, state="done")
    if todo is None:
        return
    result.completed_todos.append({"text": text, "todo_id": tid})
    result.tools_used.append("router:todo_completed")
    _safe_trace(
        ctx,
        "router:todo_completed",
        f"Completed todo (cosine={score:.2f})",
        {"match": match, "text": text, "id": tid},
    )


def _handle_merge(it, ctx, result, todo_service) -> None:
    match = (it.get("match") or "").strip()
    into = (it.get("merge_into") or "").strip()
    if not match or not into:
        return
    into_hit = _cosine_top_open(ctx.db, into, floor=MERGE_FLOOR)
    from_hit = _cosine_top_open(ctx.db, match, floor=MERGE_FLOOR)
    if not into_hit or not from_hit:
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Todo merge no-match for '{match}' into '{into}'",
            {"kind": "merge", "match": match, "merge_into": into},
        )
        result.failed_todo_actions.append(
            {"kind": "merge", "match": match, "merge_into": into}
        )
        return
    into_id, into_text, _ = into_hit
    from_id, from_text, _ = from_hit
    if into_id == from_id:
        # Same row matched both terms — extractor likely fired both
        # `match` and `merge_into` against one todo. Skip silently.
        return
    merged = todo_service.merge(ctx.db, into_id, [from_id])
    if merged is None:
        return
    result.merged_todos.append(
        {
            "into_text": into_text,
            "into_id": into_id,
            "from_text": from_text,
            "from_id": from_id,
        }
    )
    result.tools_used.append("router:todo_merged")
    _safe_trace(
        ctx,
        "router:todo_merged",
        "Merged todo",
        {
            "into": into_text,
            "from": from_text,
            "into_id": into_id,
            "from_id": from_id,
        },
    )
