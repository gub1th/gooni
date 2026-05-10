"""Item service — thin facade over focus_service + todo_service.

After the focus / todo / backlog extraction (PR XYZ), this module no
longer owns its own table. It delegates focus operations to focus_service
and todo operations to todo_service, and provides the unified `list_tree`
shape the dashboard frontend already expects.

Kept as a facade (instead of deleted) so the existing /items/* routes
and orchestrator/take/snapshot callsites don't all have to be rewritten
in lockstep — they import `item_service` and `_serialize` and keep
working.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, Todo
from .focus_service import focus_service, serialize_focus
from .todo_service import todo_service, serialize_todo


_STALE_DAYS = 7


class ItemService:
    """Public surface preserved for the existing routes / callsites.

    Routing rules:
      - parent_id None + (committed=True OR endgoal set) → focus
      - parent_id None + neither                          → todo
      - parent_id not None                                → todo with
        focus_id set to the parent focus (legacy M2M was dropped in
        the dashboard-revamp PR; one todo links to at most one focus).
    """

    # ── CRUD ────────────────────────────────────────────────────────────

    def get(self, db: Session, item_id: int) -> Focus | Todo | None:
        f = focus_service.get(db, item_id)
        if f:
            return f
        return todo_service.get(db, item_id)

    def create(
        self,
        db: Session,
        text: str,
        parent_id: int | None = None,
        endgoal: str | None = None,
        committed: bool = False,
        due_date: datetime | None = None,
        source_note_id: int | None = None,
        status: str | None = None,
        scale: str | None = None,
        health: int | None = None,
        confidence: int | None = None,
        start_at: datetime | None = None,
        end_at: datetime | None = None,
    ) -> Focus | Todo:
        if parent_id is not None:
            parent = focus_service.get(db, parent_id)
            if not parent:
                raise ValueError(
                    f"parent_id {parent_id} must reference a focus (not a todo)"
                )
            return todo_service.create(
                db,
                text=text,
                due_date=due_date,
                source_note_id=source_note_id,
                focus_id=parent.id,
            )

        is_focus = bool(committed) or bool(endgoal)
        if is_focus:
            return focus_service.create(
                db,
                text=text,
                endgoal=endgoal,
                committed=committed,
                source_note_id=source_note_id,
                status=status,
                scale=scale,
                health=health,
                confidence=confidence,
                start_at=start_at,
                end_at=end_at,
            )
        return todo_service.create(
            db,
            text=text,
            due_date=due_date,
            source_note_id=source_note_id,
        )

    def update(self, db: Session, item_id: int, **patch: Any) -> Focus | Todo | None:
        f = focus_service.get(db, item_id)
        if f:
            return focus_service.update(db, item_id, **patch)
        t = todo_service.get(db, item_id)
        if t:
            return todo_service.update(db, item_id, **patch)
        return None

    def delete(self, db: Session, item_id: int) -> bool:
        if focus_service.get(db, item_id):
            return focus_service.delete(db, item_id)
        if todo_service.get(db, item_id):
            return todo_service.delete(db, item_id)
        return False

    def reorder(self, db: Session, ordered_ids: list[int]) -> None:
        """Reorder a mixed bag of focuses + todos. Each id resolves to one
        table; indices are written per-table so cross-section drags
        renumber both sides correctly.
        """
        focus_ids = [
            i for i in ordered_ids
            if db.query(Focus.id).filter(Focus.id == i).first()
        ]
        todo_ids = [i for i in ordered_ids if i not in set(focus_ids)]
        if focus_ids:
            focus_service.reorder(db, focus_ids)
        if todo_ids:
            todo_service.reorder(db, todo_ids)

    # ── Tree + derived views ────────────────────────────────────────────

    def list_tree(
        self,
        db: Session,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        """Return focuses + inbox-style todos in the shape FocusFlow expects.

        Children-of-focus are gone post-extraction; the linked todos
        (focus_todo_links) take their place but render in the dashboard's
        Today's todos section, not as nested rows under each focus.

        Pagination is at the *root* level — top N focuses + top N todos
        (no children to slice now). `limit` clamped to [1, 200] to prevent
        runaway requests; `offset` clamped to >= 0.

        Shape:
          {
            "focuses":       [...up to limit roots],
            "inbox":         [...up to limit roots],
            "total_focuses": int,
            "total_inbox":   int,
            "limit":         int,
            "offset":        int,
          }
        """
        limit = max(1, min(200, limit))
        offset = max(0, offset)

        focuses = focus_service.list_active(db)
        todos = todo_service.list_open(db)
        return {
            "focuses": [
                _focus_tree_node(db, f) for f in focuses[offset : offset + limit]
            ],
            "inbox": [
                _todo_tree_node(t) for t in todos[offset : offset + limit]
            ],
            "total_focuses": len(focuses),
            "total_inbox": len(todos),
            "limit": limit,
            "offset": offset,
        }

    def today(self, db: Session) -> list[dict[str, Any]]:
        """Compatibility shim — delegates to todo_service.today()."""
        return todo_service.today(db)

    # ── Orchestrator context ────────────────────────────────────────────

    def get_active_context(self, db: Session) -> str:
        return focus_service.get_active_context(db)


def _focus_tree_node(db: Session, f: Focus) -> dict[str, Any]:
    todo_count = (
        db.query(Todo).filter(Todo.focus_id == f.id).count()
    )
    done_count = (
        db.query(Todo)
        .filter(Todo.focus_id == f.id, Todo.done.is_(True))
        .count()
    )
    updated = f.updated_at or f.created_at
    stale = bool(
        updated
        and (datetime.utcnow() - updated).days >= _STALE_DAYS
    )
    return {
        **serialize_focus(f),
        # Compatibility: legacy shape was `{children, progress, stale}`.
        # Children are gone after extraction; surface as empty list so
        # rendering paths don't NPE.
        "children": [],
        "progress": {"done": done_count, "total": todo_count},
        "stale": stale,
        # Legacy frontend reads parent_id / list_id / actionable from the
        # node. None values keep the type-checker happy without lying.
        "parent_id": None,
        "list_id": None,
        "actionable": True,
    }


def _todo_tree_node(t: Todo) -> dict[str, Any]:
    return {
        **serialize_todo(t),
        "children": [],
        "progress": {"done": 0, "total": 0},
        "stale": False,
        "parent_id": None,
        "list_id": None,
        "actionable": True,
        # Todos don't carry these — return None for legacy consumers.
        "endgoal": None,
        "committed": False,
        "status": None,
        "scale": None,
        "health": None,
        "confidence": None,
        "start_at": None,
        "end_at": None,
    }


# Compatibility re-export — legacy callers do
#   `from .item_service import _serialize`
def _serialize(item: Focus | Todo) -> dict[str, Any]:
    if isinstance(item, Focus):
        return serialize_focus(item)
    return serialize_todo(item)


item_service = ItemService()
