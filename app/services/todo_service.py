"""Todo CRUD over the dedicated `todos` table.

After the dashboard revamp, todos carry:
  - a 3-state enum (`not_yet` | `doing` | `done`) — UI cycles via two
    checkbox clicks; the legacy `done` boolean stays in sync so old
    callers reading `done` keep working.
  - `focus_id` FK (single — legacy M2M `focus_todo_links` dropped).
  - `is_primary` singleton — only one Todo across the whole table can
    have is_primary=True. Service enforces.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, Todo
from .list_service import _item_embed_text, list_service


VALID_STATES = ("not_yet", "doing", "done")


def _state_to_done(state: str) -> bool:
    return state == "done"


def _next_state(current: str) -> str:
    """Two-click cycle: not_yet → doing → done. From `done`, the UI
    pops a state-picker modal instead of cycling — but the helper still
    bounces back to not_yet so programmatic callers have a sensible
    default."""
    return {
        "not_yet": "doing",
        "doing": "done",
        "done": "not_yet",
    }.get(current, "doing")


class TodoService:
    def get(self, db: Session, todo_id: int) -> Todo | None:
        return db.query(Todo).filter(Todo.id == todo_id).first()

    def list_open(self, db: Session) -> list[Todo]:
        """All not-yet-done todos, sorted with `doing` floated above
        `not_yet` and tied within state by sort_order."""
        # SQLite: CASE in ORDER BY — `doing` (rank 0) sorts before
        # `not_yet` (rank 1). Done rows excluded.
        from sqlalchemy import case
        state_rank = case(
            (Todo.state == "doing", 0),
            (Todo.state == "not_yet", 1),
            else_=2,
        )
        return (
            db.query(Todo)
            .filter(Todo.done.is_(False))
            .order_by(state_rank, Todo.sort_order, Todo.id)
            .all()
        )

    def list_done_today(self, db: Session) -> list[Todo]:
        """Todos completed today (used by the Done section's Completed
        view). 'Today' uses local UTC midnight — same boundary that
        Daniel's daily snapshots use."""
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        return (
            db.query(Todo)
            .filter(
                Todo.done.is_(True),
                Todo.completed_at.is_not(None),
                Todo.completed_at >= today_start,
            )
            .order_by(Todo.completed_at.desc())
            .all()
        )

    def get_primary(self, db: Session) -> Todo | None:
        return (
            db.query(Todo)
            .filter(Todo.is_primary.is_(True), Todo.done.is_(False))
            .first()
        )

    def create(
        self,
        db: Session,
        text: str,
        due_date: datetime | None = None,
        source_note_id: int | None = None,
        subtitle: str | None = None,
        focus_id: int | None = None,
        state: str = "not_yet",
    ) -> Todo:
        if state not in VALID_STATES:
            state = "not_yet"

        max_order = (
            db.query(Todo.sort_order)
            .order_by(Todo.sort_order.desc())
            .first()
        )
        next_order = (max_order[0] + 1) if max_order else 1

        embed_raw = _item_embed_text(text, subtitle)
        embed_vec = list_service._embed_item_text(embed_raw)

        t = Todo(
            text=text.strip(),
            subtitle=subtitle,
            due_date=due_date,
            sort_order=next_order,
            source_note_id=source_note_id,
            focus_id=focus_id,
            state=state,
            done=_state_to_done(state),
            completed_at=datetime.utcnow() if state == "done" else None,
            embedding=json.dumps(embed_vec) if embed_vec else None,
        )
        db.add(t)
        db.commit()
        db.refresh(t)
        return t

    def update(self, db: Session, todo_id: int, **patch: Any) -> Todo | None:
        t = self.get(db, todo_id)
        if not t:
            return None

        # is_primary singleton — clear any other primary before setting.
        # Auto-clear on completion: if the caller is marking this todo
        # done (via state='done' or done=True), drop the primary flag so
        # tomorrow's slot opens. Resolves hole 1 from the audit.
        if patch.get("is_primary") is True:
            db.query(Todo).filter(
                Todo.is_primary.is_(True), Todo.id != todo_id
            ).update({"is_primary": False}, synchronize_session=False)

        if "state" in patch:
            new_state = patch["state"]
            if new_state not in VALID_STATES:
                raise ValueError(f"state must be one of {VALID_STATES}")
            t.state = new_state
            t.done = _state_to_done(new_state)
            t.completed_at = datetime.utcnow() if new_state == "done" else None
            if new_state == "done":
                t.is_primary = False
        elif "done" in patch:
            new_done = bool(patch["done"])
            t.done = new_done
            t.state = "done" if new_done else "not_yet"
            t.completed_at = datetime.utcnow() if new_done else None
            if new_done:
                t.is_primary = False

        for key in ("text", "subtitle", "due_date", "sort_order", "focus_id", "is_primary"):
            if key in patch:
                setattr(t, key, patch[key])

        if any(k in patch for k in ("text", "subtitle")):
            embed_raw = _item_embed_text(t.text, t.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                t.embedding = json.dumps(vec)

        db.commit()
        db.refresh(t)

        # Auto-sync linked backlog ticket: when a todo flips done, its
        # backlog ticket (if any links to it) flips done too. Same in
        # reverse if the todo flips back to not-done.
        if "state" in patch or "done" in patch:
            from ..db.models import BacklogTicket
            tickets = (
                db.query(BacklogTicket)
                .filter(BacklogTicket.todo_id == todo_id)
                .all()
            )
            for tk in tickets:
                if tk.done != t.done:
                    tk.done = t.done
                    tk.completed_at = datetime.utcnow() if t.done else None
                    tk.board_status = "done" if t.done else (tk.board_status or "doing")
            if tickets:
                db.commit()

        return t

    def cycle_state(self, db: Session, todo_id: int) -> Todo | None:
        """Two-click checkbox handler. Resolves to the next state in the
        forward cycle (not_yet → doing → done)."""
        t = self.get(db, todo_id)
        if not t:
            return None
        return self.update(db, todo_id, state=_next_state(t.state))

    def delete(self, db: Session, todo_id: int) -> bool:
        t = self.get(db, todo_id)
        if not t:
            return False
        # Clear backlog ticket link, if any.
        from ..db.models import BacklogTicket
        db.query(BacklogTicket).filter(BacklogTicket.todo_id == todo_id).update(
            {"todo_id": None}, synchronize_session=False
        )
        db.delete(t)
        db.commit()
        return True

    def reorder(self, db: Session, ordered_ids: list[int]) -> None:
        for idx, tid in enumerate(ordered_ids):
            db.query(Todo).filter(Todo.id == tid).update(
                {"sort_order": idx}, synchronize_session=False
            )
        db.commit()

    def today(self, db: Session) -> list[dict[str, Any]]:
        """Open todos due today. Each row carries a single optional focus
        chip (matches the new single-FK model — was an array under the
        legacy M2M)."""
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)
        rows = (
            db.query(Todo)
            .filter(
                Todo.done.is_(False),
                Todo.due_date.is_not(None),
                Todo.due_date >= today_start,
                Todo.due_date < today_end,
            )
            .order_by(Todo.sort_order, Todo.id)
            .all()
        )
        out: list[dict[str, Any]] = []
        for t in rows:
            focus_chip: dict[str, Any] | None = None
            if t.focus_id is not None:
                f = db.query(Focus.id, Focus.text, Focus.color).filter(Focus.id == t.focus_id).first()
                if f:
                    focus_chip = {"id": f[0], "text": f[1], "color": f[2]}
            out.append({
                **serialize_todo(t),
                # Kept as a list for back-compat w/ the previous chip-array
                # response shape; will always be 0 or 1 element now.
                "focuses": [focus_chip] if focus_chip else [],
            })
        return out

    def linked_focus(self, db: Session, todo_id: int) -> Focus | None:
        t = self.get(db, todo_id)
        if not t or not t.focus_id:
            return None
        return db.query(Focus).filter(Focus.id == t.focus_id).first()


def serialize_todo(t: Todo) -> dict[str, Any]:
    return {
        "id": t.id,
        "text": t.text,
        "subtitle": t.subtitle,
        "state": t.state,
        "focus_id": t.focus_id,
        "is_primary": bool(t.is_primary),
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "done": bool(t.done),
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "sort_order": t.sort_order,
        "source_note_id": t.source_note_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


todo_service = TodoService()
