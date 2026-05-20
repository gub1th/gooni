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
EDIT_FLOOR = 0.60
DONE_SIGNAL_FLOOR = 0.85

# G3.9: disambiguation gap. If the top two candidate matches score
# within this delta of each other, the handler refuses to execute and
# surfaces a "which one — A or B?" question. One wrong auto-action
# erodes trust faster than ten correct ones build it.
AMBIGUITY_GAP = 0.05


_DUE_HINTS = {
    "tonight": ("today_eod", None),
    "today": ("today_eod", None),
    "tomorrow": ("plus_days", 1),
    "this week": ("plus_days", 7),
}


def _parse_due(hint):
    """Resolve a due-hint phrase to a concrete datetime (UTC, EOD-anchored).

    Two-tier strategy:
      1. Regex map (_DUE_HINTS) handles the canonical phrases the LLM
         emits as enum-shaped strings ("tomorrow", "tonight", etc.).
         Fast, deterministic, no external call.
      2. `dateparser` fallback for free-form phrases the LLM might emit
         that we never enumerated ("in 3 days", "next friday", "by aug 5",
         "2 weeks from tuesday"). Pure Python, no LLM cost, ~3ms.

    Stays null for context-dependent phrases ("soon", "before the trip",
    "when i get back") — those need state Gooni doesn't reliably have.
    Daniel can pick a date manually if it matters.
    """
    if not hint:
        return None
    h = hint.strip().lower()
    rule = _DUE_HINTS.get(h)
    now = datetime.utcnow()
    if rule:
        kind, arg = rule
        if kind == "today_eod":
            return now.replace(hour=23, minute=59, second=0, microsecond=0)
        if kind == "plus_days" and isinstance(arg, int):
            return (now + timedelta(days=arg)).replace(
                hour=23, minute=59, second=0, microsecond=0
            )

    # Regex map missed — try dateparser. PREFER_DATES_FROM='future' so
    # "friday" resolves to the NEXT friday, not last. RETURN_AS_TIMEZONE_AWARE
    # off because the rest of the codebase stores naive UTC.
    try:
        import dateparser
        parsed = dateparser.parse(
            h,
            settings={
                "PREFER_DATES_FROM": "future",
                "RETURN_AS_TIMEZONE_AWARE": False,
            },
        )
        if parsed is not None:
            # If dateparser returned a date-only (midnight), nudge to EOD so
            # todos due "next friday" don't expire at 00:00.
            if parsed.hour == 0 and parsed.minute == 0:
                parsed = parsed.replace(hour=23, minute=59, second=0, microsecond=0)
            return parsed
    except Exception as e:
        print(f"[todos handler] dateparser failed on '{h}': {e}")
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
    semantics — diverging them would be a silent bug factory.

    NOTE: doesn't enforce the ambiguity gap — callers wanting that
    behavior should use `resolve_cosine_match` instead, which returns
    a single | ambiguous | none triplet.
    """
    from ...tools.todo_tools import _cosine_match_open_todos

    matches = _cosine_match_open_todos(db, query_text, floor=floor, limit=1)
    if not matches:
        return None
    tid, text, _sub, score = matches[0]
    return (tid, text, score)


def resolve_cosine_match(db, query_text: str, floor: float):
    """G3.9 disambiguation-aware cosine match resolver.

    Returns one of:
      {"kind": "single",     "todo": (tid, text, score)}
      {"kind": "ambiguous",  "candidates": [(tid, text, score), ...]}
      {"kind": "none"}

    "ambiguous" fires when top1 - top2 < AMBIGUITY_GAP. The handler
    should NOT execute and should queue a disambiguation question via
    result.disambiguation_needed instead. Daniel's next turn with more
    specific text will re-resolve cleanly.
    """
    from ...tools.todo_tools import _cosine_match_open_todos

    matches = _cosine_match_open_todos(db, query_text, floor=floor, limit=5)
    if not matches:
        return {"kind": "none"}
    # matches sorted desc by score
    top = matches[0]
    if len(matches) == 1:
        return {"kind": "single", "todo": (top[0], top[1], top[3])}
    second = matches[1]
    if (top[3] - second[3]) < AMBIGUITY_GAP:
        # Bundle all candidates within the gap so the ack can render them.
        cluster = [
            (m[0], m[1], m[3]) for m in matches
            if (top[3] - m[3]) < AMBIGUITY_GAP
        ]
        return {"kind": "ambiguous", "candidates": cluster}
    return {"kind": "single", "todo": (top[0], top[1], top[3])}


def _queue_disambiguation(result, action: str, match: str, candidates: list) -> None:
    """Append a disambiguation request to result.disambiguation_needed.
    Candidates is the list of (tid, text, score) tuples from
    resolve_cosine_match.
    """
    result.disambiguation_needed.append({
        "action": action,
        "match": match,
        "candidates": [
            {"id": tid, "text": text, "score": round(score, 3)}
            for tid, text, score in candidates
        ],
    })


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
            elif kind == "edit":
                _handle_edit(it, ctx, result, todo_service)
            # Unknown kinds dropped silently — normalize step already
            # validates, so this only catches future-kind drift.
        except Exception as e:
            print(f"[todos handler] {kind} error: {e}")
            continue


def handle_done_signals(items: list[dict], ctx, result) -> None:
    """G3.9 implicit-done dispatch. Each item: {phrase, match}. The
    extractor catches utterances like "just called papi" / "finished X"
    / "did Y already" — we cosine-resolve `match` against open todos at
    DONE_SIGNAL_FLOOR (0.85, strict), apply the disambiguation gap, then
    auto-close. Ack composer renders the implicit-done phrase + offers
    inline undo.
    """
    if not items:
        return

    from ..todo_service import todo_service

    for it in items:
        match = (it.get("match") or "").strip()
        phrase = (it.get("phrase") or "").strip()
        if not match or not phrase:
            continue
        try:
            res = resolve_cosine_match(ctx.db, match, floor=DONE_SIGNAL_FLOOR)
            if res["kind"] == "none":
                _safe_trace(
                    ctx,
                    "router:done_signal_no_match",
                    f"Implicit-done no-match for '{match}' (phrase: '{phrase}')",
                    {"match": match, "phrase": phrase, "floor": DONE_SIGNAL_FLOOR},
                )
                continue
            if res["kind"] == "ambiguous":
                _queue_disambiguation(result, "done_signal", match, res["candidates"])
                _safe_trace(
                    ctx,
                    "router:done_signal_ambiguous",
                    f"Implicit-done ambiguous for '{match}'",
                    {"match": match, "phrase": phrase, "candidates": len(res["candidates"])},
                )
                continue
            tid, text, score = res["todo"]
            todo = todo_service.update(ctx.db, tid, state="done")
            if todo is None:
                continue
            result.implicit_done_todos.append({
                "text": text,
                "todo_id": tid,
                "phrase": phrase,
            })
            result.tools_used.append("router:todo_implicit_done")
            _safe_trace(
                ctx,
                "router:todo_implicit_done",
                f"Implicit-done closed (cosine={score:.2f})",
                {"match": match, "phrase": phrase, "text": text, "id": tid},
            )
        except Exception as e:
            print(f"[done_signals handler] error: {e}")
            continue


def _handle_edit(it, ctx, result, todo_service) -> None:
    """G3.9 edit dispatch. Cosine-resolves the existing todo by `match`,
    applies patch fields. Supported patch keys:
      text, subtitle, due_hint, primary, parent_match, unlink_parent, position
    Each applied change appended to a human-readable list for the ack.
    """
    from ..todo_service import todo_service as _ts
    _ = _ts  # noqa: F841 — keep import warm

    match = (it.get("match") or "").strip()
    patch = it.get("patch") or {}
    if not match or not isinstance(patch, dict) or not patch:
        return

    res = resolve_cosine_match(ctx.db, match, floor=EDIT_FLOOR)
    if res["kind"] == "none":
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Edit no-match for '{match}'",
            {"kind": "edit", "match": match, "floor": EDIT_FLOOR},
        )
        result.failed_todo_actions.append({"kind": "edit", "match": match})
        return
    if res["kind"] == "ambiguous":
        _queue_disambiguation(result, "edit", match, res["candidates"])
        _safe_trace(
            ctx,
            "router:todo_edit_ambiguous",
            f"Edit ambiguous for '{match}'",
            {"match": match, "patch_keys": list(patch.keys()), "candidates": len(res["candidates"])},
        )
        return

    tid, original_text, score = res["todo"]
    todo = todo_service.get(ctx.db, tid)
    if todo is None:
        return

    update_kwargs: dict = {}
    changes: list[str] = []
    snapshot = {
        "text": todo.text,
        "subtitle": todo.subtitle,
        "due_date": todo.due_date.isoformat() if todo.due_date else None,
        "is_primary": bool(todo.is_primary),
    }

    if "text" in patch:
        update_kwargs["text"] = patch["text"]
        changes.append(f"renamed → \"{patch['text']}\"")
    if "subtitle" in patch:
        update_kwargs["subtitle"] = patch["subtitle"]
        changes.append("subtitle set")
    if "due_hint" in patch:
        new_due = _parse_due(patch["due_hint"])
        if new_due is not None:
            update_kwargs["due_date"] = new_due
            changes.append(f"due → {patch['due_hint']}")
        else:
            # Couldn't parse — mark as ambiguous-hint, ack can ask Daniel.
            changes.append(f"due-hint '{patch['due_hint']}' unrecognized")
    if "primary" in patch:
        update_kwargs["is_primary"] = bool(patch["primary"])
        changes.append("primary=on" if patch["primary"] else "primary=off")

    if update_kwargs:
        # todo_service.update already enforces the is_primary singleton
        # (clears other crowns when one is set), so a single PATCH-shape
        # call is enough.
        todo_service.update(ctx.db, tid, **update_kwargs)

    # Parent link/unlink via spawned_from edge.
    if patch.get("unlink_parent") is True:
        try:
            _unlink_parent(ctx.db, tid)
            changes.append("unlinked parent")
        except Exception as e:
            print(f"[todos handler] unlink parent failed: {e}")
    if "parent_match" in patch:
        parent_query = patch["parent_match"]
        parent_res = resolve_cosine_match(ctx.db, parent_query, floor=EDIT_FLOOR)
        if parent_res["kind"] == "single":
            ptid, ptext, _ = parent_res["todo"]
            if ptid != tid:
                try:
                    _link_parent(ctx.db, child_id=tid, parent_id=ptid)
                    changes.append(f"linked-parent: \"{ptext}\"")
                except Exception as e:
                    print(f"[todos handler] link parent failed: {e}")
        elif parent_res["kind"] == "ambiguous":
            _queue_disambiguation(result, "edit_parent_link", parent_query, parent_res["candidates"])
        else:
            changes.append(f"parent-match '{parent_query}' no-match")

    # Position reorder. "top" / "bottom" / "above:<match>" / "below:<match>".
    if "position" in patch:
        position = patch["position"]
        try:
            applied = _apply_position(ctx.db, todo_service, tid, position)
            if applied:
                changes.append(f"position → {position}")
        except Exception as e:
            print(f"[todos handler] position reorder failed: {e}")

    if not changes:
        # Patch had nothing actionable — skip surfacing.
        return

    result.edited_todos.append({
        "text": original_text,
        "todo_id": tid,
        "changes": changes,
        "from": snapshot,
    })
    result.tools_used.append("router:todo_edited")
    _safe_trace(
        ctx,
        "router:todo_edited",
        f"Edited todo (cosine={score:.2f}): {', '.join(changes)}",
        {"match": match, "text": original_text, "id": tid, "changes": changes},
    )


def _link_parent(db, *, child_id: int, parent_id: int) -> None:
    """Wire `spawned_from` edge: child Todo → parent Todo. Idempotent on
    the 5-tuple via edge_service. Used by the chat edit handler when
    Daniel says 'X is a follow-up to Y'.
    """
    from .. import edge_service
    edge_service.link(
        db,
        src_kind="todo",
        src_id=child_id,
        dst_kind="todo",
        dst_id=parent_id,
        kind="spawned_from",
    )


def _unlink_parent(db, child_id: int) -> None:
    """Remove all `spawned_from` edges where this todo is the child.
    Edge model: child IS the src, parent IS the dst. Removes ALL parent
    edges — Daniel can re-link a specific parent in a follow-up turn.
    """
    from ..db.models import Edge
    db.query(Edge).filter(
        Edge.src_kind == "todo",
        Edge.src_id == child_id,
        Edge.dst_kind == "todo",
        Edge.kind == "spawned_from",
    ).delete(synchronize_session=False)
    db.commit()


def _apply_position(db, todo_service, todo_id: int, position: str) -> bool:
    """Apply a chat-driven position move. Returns True on success.

    Position string forms:
      "top"           → smallest sort_order
      "bottom"        → largest sort_order + 1
      "above:<match>" → set sort_order to (target.sort_order - 0.5),
                         then renormalize to ints
      "below:<match>" → same w/ +0.5
    """
    from ..db.models import Todo

    pos = (position or "").strip().lower()
    if not pos:
        return False

    todo = todo_service.get(db, todo_id)
    if todo is None:
        return False

    open_todos = todo_service.list_open(db)
    if pos == "top":
        # Set this todo's sort_order to min - 1, then renormalize.
        new_order = -1
    elif pos == "bottom":
        new_order = sum(1 for t in open_todos) + 100  # arbitrary high
    elif pos.startswith("above:") or pos.startswith("below:"):
        target_text = position.split(":", 1)[1].strip()
        from ...tools.todo_tools import _cosine_match_open_todos
        matches = _cosine_match_open_todos(db, target_text, floor=EDIT_FLOOR, limit=1)
        if not matches:
            return False
        target_tid = matches[0][0]
        if target_tid == todo_id:
            return False
        target = todo_service.get(db, target_tid)
        if target is None:
            return False
        target_so = target.sort_order or 0
        new_order = (target_so - 0.5) if pos.startswith("above:") else (target_so + 0.5)
    else:
        return False

    # Stamp the new (possibly fractional) order, then renormalize all open
    # todos to dense integer ranks so future inserts have headroom.
    todo.sort_order = new_order  # may be float temporarily
    db.commit()
    _renormalize_sort_orders(db, todo_service)
    return True


def _renormalize_sort_orders(db, todo_service) -> None:
    """Re-stamp all open todos with dense integer sort_orders matching
    their current ordering. Runs after any fractional-position write so
    sort_order stays well-behaved long-term.
    """
    from ..db.models import Todo
    rows = (
        db.query(Todo)
        .filter(Todo.done.is_(False), Todo.deleted_at.is_(None))
        .order_by(Todo.sort_order.asc().nullslast(), Todo.id.asc())
        .all()
    )
    for i, t in enumerate(rows, start=1):
        if t.sort_order != i:
            t.sort_order = i
    db.commit()


def _handle_create(it, ctx, result, todo_service) -> None:
    text = (it.get("text") or "").strip()
    if not text:
        return
    due_at = _parse_due(it.get("due_hint"))

    # G3: dedup + mention-bump moved into todo_service.create itself. When
    # the new text cosine-matches an open todo at ≥0.85, the service bumps
    # the existing row's mention_count + last_mentioned_at + mention_history
    # and returns it instead of inserting a duplicate. We surface the
    # mention_count so the ack composer can escalate tone at ≥3 mentions
    # ("third mention. tonight or kill it.") — silence isn't helping.
    todo = todo_service.create(
        ctx.db,
        text=text,
        due_date=due_at,
        source_note_id=ctx.source_note_id,
    )
    bumped = (todo.mention_count or 1) > 1
    result.captured_todos.append({
        "text": todo.text,
        "todo_id": todo.id,
        "mention_count": todo.mention_count or 1,
        "bumped": bumped,
    })
    result.tools_used.append("router:todo_bumped" if bumped else "router:todo")
    _safe_trace(
        ctx,
        "router:todo_bumped" if bumped else "router:todo",
        f"Mention-bumped existing todo (count={todo.mention_count})" if bumped else "Captured todo",
        {"text": todo.text, "due_hint": it.get("due_hint"), "todo_id": todo.id, "mention_count": todo.mention_count},
    )


def _handle_delete(it, ctx, result, todo_service) -> None:
    match = (it.get("match") or "").strip()
    if not match:
        return
    res = resolve_cosine_match(ctx.db, match, floor=DELETE_FLOOR)
    if res["kind"] == "none":
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Todo delete no-match for '{match}'",
            {"kind": "delete", "match": match, "floor": DELETE_FLOOR},
        )
        result.failed_todo_actions.append({"kind": "delete", "match": match})
        return
    if res["kind"] == "ambiguous":
        _queue_disambiguation(result, "delete", match, res["candidates"])
        _safe_trace(
            ctx,
            "router:todo_delete_ambiguous",
            f"Delete ambiguous for '{match}'",
            {"match": match, "candidates": len(res["candidates"])},
        )
        return
    tid, text, score = res["todo"]
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
    res = resolve_cosine_match(ctx.db, match, floor=COMPLETE_FLOOR)
    if res["kind"] == "none":
        _safe_trace(
            ctx,
            "router:todo_no_match",
            f"Todo complete no-match for '{match}'",
            {"kind": "complete", "match": match, "floor": COMPLETE_FLOOR},
        )
        result.failed_todo_actions.append({"kind": "complete", "match": match})
        return
    if res["kind"] == "ambiguous":
        _queue_disambiguation(result, "complete", match, res["candidates"])
        _safe_trace(
            ctx,
            "router:todo_complete_ambiguous",
            f"Complete ambiguous for '{match}'",
            {"match": match, "candidates": len(res["candidates"])},
        )
        return
    tid, text, score = res["todo"]

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
