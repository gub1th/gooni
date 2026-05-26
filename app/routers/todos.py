
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..common import (
    _parse_optional_due
)


router = APIRouter()


@router.get("/todos")
def todos_list(db: Session = Depends(get_db)):
    """Open + completed-today todos, grouped. Powers the todo list UI.

    G3.5: bundle now carries `chain_summary` — a per-todo-id map of
    lineage metadata so Surface C (chain indicators ↗N + "from:" line)
    can render without N+1 chain fetches. Shape:
      chain_summary[id] = {
        children_total: int,    # spawned_from edges pointing here
        children_done:  int,    # of which, how many are state=done
        parent_id:      int|null,
        parent_text:    str|null,
      }
    Computed in one query over the edges table; falls back to empty
    map if the query fails (Surface C just won't render indicators).
    """
    from ..db.models import Edge, Todo as TodoModel
    from ..services.todo_service import todo_service, serialize_todo

    open_rows = todo_service.list_open(db)
    done_today = todo_service.list_done_today(db)
    primary = todo_service.get_primary(db)

    # Pull every spawned_from edge in one shot. The set of todo ids we
    # care about = primary + open + done_today (plus their parents +
    # children — pull lazily via the parent_text lookup below).
    relevant_ids: set[int] = set()
    if primary is not None:
        relevant_ids.add(primary.id)
    for t in open_rows + done_today:
        relevant_ids.add(t.id)

    chain_summary: dict[int, dict] = {}
    try:
        # Edges where any relevant todo is on either side.
        edge_rows = (
            db.query(Edge)
            .filter(Edge.kind == "spawned_from")
            .filter(Edge.src_kind == "todo", Edge.dst_kind == "todo")
            .all()
        )

        # Build child→parent map + parent→children map.
        child_to_parent: dict[int, int] = {}
        parent_to_children: dict[int, list[int]] = {}
        for e in edge_rows:
            child_to_parent[e.src_id] = e.dst_id
            parent_to_children.setdefault(e.dst_id, []).append(e.src_id)

        # Hydrate any todo ids referenced as parent/child that aren't in
        # our visible set — needed for parent_text lookup + child-state
        # counting.
        extra_ids: set[int] = set()
        for cid, pid in child_to_parent.items():
            if cid in relevant_ids:
                extra_ids.add(pid)
        for pid, cids in parent_to_children.items():
            if pid in relevant_ids:
                extra_ids |= set(cids)
        all_ids = relevant_ids | extra_ids
        if all_ids:
            todo_lookup = {
                t.id: t
                for t in db.query(TodoModel)
                .filter(TodoModel.id.in_(all_ids))
                .all()
            }
        else:
            todo_lookup = {}

        for tid in relevant_ids:
            children = parent_to_children.get(tid, [])
            child_total = len(children)
            child_done = sum(
                1
                for cid in children
                if (todo_lookup.get(cid) and todo_lookup[cid].done)
            )
            parent_id = child_to_parent.get(tid)
            parent_text = (
                (todo_lookup.get(parent_id).text or "").strip()
                if parent_id and todo_lookup.get(parent_id)
                else None
            )
            if child_total > 0 or parent_id is not None:
                chain_summary[tid] = {
                    "children_total": child_total,
                    "children_done": child_done,
                    "parent_id": parent_id,
                    "parent_text": parent_text,
                }
    except Exception as e:
        print(f"[todos chain_summary] failed: {e}")
        chain_summary = {}

    # Attachment counts for the paperclip badge — ONE grouped query over the
    # visible ids (not per-row → no N+1). Failure degrades to no badges.
    from sqlalchemy import func
    from ..db.models import Attachment
    att_counts: dict[int, int] = {}
    try:
        if relevant_ids:
            att_counts = {
                tid: cnt
                for tid, cnt in db.query(Attachment.todo_id, func.count(Attachment.id))
                .filter(Attachment.todo_id.in_(relevant_ids))
                .group_by(Attachment.todo_id)
                .all()
            }
    except Exception as e:
        print(f"[todos attachment_counts] failed: {e}")
        att_counts = {}

    def _with_att(d: dict) -> dict:
        d["attachment_count"] = att_counts.get(d["id"], 0)
        return d

    return {
        "primary": _with_att(serialize_todo(primary)) if primary else None,
        "open": [_with_att(serialize_todo(t)) for t in open_rows if not t.is_primary],
        "done_today": [_with_att(serialize_todo(t)) for t in done_today],
        "chain_summary": chain_summary,
    }


@router.post("/todos")
def todos_create(body: dict, db: Session = Depends(get_db)):
    """Inline-create a todo. Body: {text, focus_id?, due_date?, subtitle?,
    state?}. The dashboard's "+" button hits this."""
    from ..services.todo_service import todo_service, serialize_todo
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    due_date = _parse_optional_due(body.get("due_date"))
    todo = todo_service.create(
        db,
        text=text_val,
        subtitle=body.get("subtitle"),
        due_date=due_date,
        focus_id=body.get("focus_id"),
        state=(body.get("state") or "not_yet"),
    )
    return serialize_todo(todo)


@router.patch("/todos/{todo_id}")
def todos_update(todo_id: int, body: dict, db: Session = Depends(get_db)):
    from ..services.todo_service import todo_service, serialize_todo
    patch: dict = {}
    for key in ("text", "subtitle", "state", "focus_id", "is_primary", "sort_order", "done", "closure_note"):
        if key in body:
            patch[key] = body[key]
    if "due_date" in body:
        patch["due_date"] = _parse_optional_due(body["due_date"])
    try:
        t = todo_service.update(db, todo_id, **patch)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


@router.post("/todos/{todo_id}/cycle")
def todos_cycle(todo_id: int, db: Session = Depends(get_db)):
    """Two-click checkbox handler. Cycles state forward:
       not_yet → doing → done. From `done`, the FE opens a state-picker
       modal; cycle still bounces to not_yet for programmatic safety."""
    from ..services.todo_service import todo_service, serialize_todo
    t = todo_service.cycle_state(db, todo_id)
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


@router.delete("/todos/{todo_id}")
def todos_delete(todo_id: int, db: Session = Depends(get_db)):
    """Soft-delete (G1). Stamps deleted_at; the row stays for 24h so
    `POST /todos/{id}/undelete` can restore. Hard-purge happens via the
    lifespan sweeper.
    """
    from ..services.todo_service import todo_service
    if not todo_service.delete(db, todo_id):
        raise HTTPException(status_code=404, detail="todo not found")
    return {"ok": True, "soft_deleted": True}


@router.post("/todos/{todo_id}/undelete")
def todos_undelete(todo_id: int, db: Session = Depends(get_db)):
    """Reverse a soft-delete within the 24h window. 404 if row doesn't
    exist or wasn't deleted. 410 if the undo window has expired."""
    from ..services.todo_service import todo_service, serialize_todo, SOFT_DELETE_TTL_HOURS
    t = todo_service.undelete(db, todo_id)
    if t is None:
        # Distinguish "no such tombstone" from "window expired" for the
        # caller — the latter is a 410 (gone) per HTTP semantics.
        raw = todo_service.get(db, todo_id, include_deleted=True)
        if raw is None:
            raise HTTPException(status_code=404, detail="todo not found")
        if raw.deleted_at is None:
            raise HTTPException(status_code=409, detail="todo is not deleted")
        raise HTTPException(
            status_code=410,
            detail=f"undo window expired ({SOFT_DELETE_TTL_HOURS}h)",
        )
    return serialize_todo(t)


@router.post("/todos/bulk-delete")
def todos_bulk_delete(payload: dict, db: Session = Depends(get_db)):
    """Soft-delete N todos in one call. Body: { ids: [int] }. Returns the
    ids actually soft-deleted (skips missing or already-deleted rows)."""
    from ..services.todo_service import todo_service
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list of int")
    try:
        ids = [int(i) for i in raw_ids]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="ids must be a list of int")
    deleted = todo_service.bulk_soft_delete(db, ids)
    return {"deleted_ids": deleted, "count": len(deleted)}


@router.post("/todos/merge")
def todos_merge(payload: dict, db: Session = Depends(get_db)):
    """Merge N todos into one. Body: { primary_id: int, merged_ids: [int] }.
    Concats merged.text into primary.subtitle (newline-joined, `+ ` prefix),
    soft-deletes the merged rows. Primary's text is left alone."""
    from ..services.todo_service import todo_service, serialize_todo
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid body")
    try:
        primary_id = int(payload.get("primary_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="primary_id required")
    raw_merged = payload.get("merged_ids") or []
    if not isinstance(raw_merged, list):
        raise HTTPException(status_code=400, detail="merged_ids must be a list")
    try:
        merged_ids = [int(i) for i in raw_merged]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="merged_ids must be int list")
    primary = todo_service.merge(db, primary_id, merged_ids)
    if primary is None:
        raise HTTPException(status_code=404, detail="primary todo not found")
    return serialize_todo(primary)


@router.post("/todos/{todo_id}/promote-to-primary")
def todos_promote_primary(todo_id: int, db: Session = Depends(get_db)):
    """Singleton: clears any other primary, sets this one. Idempotent."""
    from ..services.todo_service import todo_service, serialize_todo
    t = todo_service.update(db, todo_id, is_primary=True)
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


@router.post("/todos/{todo_id}/close")
def todos_close(todo_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db)):
    """Close a todo with optional outcome + spawned follow-ups.

    Body:
      closure_note: optional str — short outcome text
      spawned:      optional list of {text, due_hint?, subtitle?}

    Single transaction. Each spawned entry becomes a new Todo with a
    `spawned_from` edge pointing back to todo_id. Children inherit the
    parent's focus_id so chains stay within the same focus context.

    Returns:
      {"parent": serialized, "spawned": [serialized, ...], "edges": [id, ...]}
    """
    from ..services.todo_service import todo_service

    closure_note = payload.get("closure_note") if isinstance(payload, dict) else None
    spawned = payload.get("spawned") if isinstance(payload, dict) else None
    if spawned is not None and not isinstance(spawned, list):
        raise HTTPException(status_code=400, detail="spawned must be a list")

    result = todo_service.close_with_outcome(
        db,
        todo_id,
        closure_note=closure_note if isinstance(closure_note, str) else None,
        spawned=spawned,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return result


@router.get("/todos/{todo_id}/chain")
def todos_chain(
    todo_id: int,
    max_depth: int = 10,
    db: Session = Depends(get_db),
):
    """Walk the lineage graph centered on this todo. Returns ancestors +
    descendants + self in serialized form. Soft-deleted nodes included
    (chain history matters even when killed); caller decides render."""
    from ..services.todo_service import todo_service

    max_depth = max(1, min(int(max_depth or 10), 20))
    chain = todo_service.get_chain(db, todo_id, max_depth=max_depth)
    if chain is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return chain


@router.post("/todos/{todo_id}/link-parent")
def todos_link_parent(
    todo_id: int,
    payload: dict = Body(default={}),
    db: Session = Depends(get_db),
):
    """Wire a `spawned_from` edge from todo_id (child) → parent_id (ancestor).
    Idempotent. Used by retroactive-linking UI."""
    from ..services.todo_service import todo_service

    parent_id = payload.get("parent_id") if isinstance(payload, dict) else None
    if not isinstance(parent_id, int):
        raise HTTPException(status_code=400, detail="parent_id required")
    ok = todo_service.add_parent(db, todo_id, parent_id)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="invalid parent_id, same-as-child, or todo missing",
        )
    return {"ok": True, "child_id": todo_id, "parent_id": parent_id}


@router.delete("/todos/{todo_id}/parents/{parent_id}")
def todos_unlink_parent(
    todo_id: int,
    parent_id: int,
    db: Session = Depends(get_db),
):
    """Drop the spawned_from edge between child and parent. Returns count
    deleted (0 or 1)."""
    from ..services.todo_service import todo_service

    deleted = todo_service.remove_parent(db, todo_id, parent_id)
    return {"deleted": deleted}


@router.get("/todos/search")
def todos_search(
    q: str,
    limit: int = 10,
    include_done: bool = True,
    db: Session = Depends(get_db),
):
    """Fuzzy substring search for retroactive linking. Returns up to
    `limit` open + done todos (excluding soft-deleted). Used by the
    Surface D link-search UI."""
    from ..services.todo_service import todo_service, serialize_todo

    limit = max(1, min(int(limit or 10), 50))
    rows = todo_service.search(
        db, q, limit=limit, include_done=include_done
    )
    return {"matches": [serialize_todo(t) for t in rows]}
