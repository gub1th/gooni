"""Todo CRUD over the dedicated `todos` table (extracted from list_items).

A todo is an actionable leaf with an optional due_date. Linked to focuses
via focus_todo_links (M2M); see focus_service for that side.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, FocusTodoLink, Todo
from .list_service import _item_embed_text, list_service


class TodoService:
    def get(self, db: Session, todo_id: int) -> Todo | None:
        return db.query(Todo).filter(Todo.id == todo_id).first()

    def list_open(self, db: Session) -> list[Todo]:
        return (
            db.query(Todo)
            .filter(Todo.done.is_(False))
            .order_by(Todo.sort_order, Todo.id)
            .all()
        )

    def create(
        self,
        db: Session,
        text: str,
        due_date: datetime | None = None,
        source_note_id: int | None = None,
        subtitle: str | None = None,
    ) -> Todo:
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
        for key in ("text", "subtitle", "due_date", "done", "sort_order"):
            if key in patch:
                setattr(t, key, patch[key])
        if "done" in patch:
            t.completed_at = datetime.utcnow() if patch["done"] else None
        if any(k in patch for k in ("text", "subtitle")):
            embed_raw = _item_embed_text(t.text, t.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                t.embedding = json.dumps(vec)
        db.commit()
        db.refresh(t)
        return t

    def delete(self, db: Session, todo_id: int) -> bool:
        t = self.get(db, todo_id)
        if not t:
            return False
        db.query(FocusTodoLink).filter(FocusTodoLink.todo_id == todo_id).delete(
            synchronize_session=False
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
        """Open todos due today, decorated with their linked focuses (chip
        array on the dashboard).
        """
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
            focus_chips = (
                db.query(Focus.id, Focus.text, Focus.is_primary)
                .join(FocusTodoLink, FocusTodoLink.focus_id == Focus.id)
                .filter(FocusTodoLink.todo_id == t.id)
                .all()
            )
            out.append({
                **serialize_todo(t),
                "focuses": [
                    {"id": fid, "text": ftext, "is_primary": bool(fp)}
                    for fid, ftext, fp in focus_chips
                ],
            })
        return out

    def linked_focuses(self, db: Session, todo_id: int) -> list[Focus]:
        return (
            db.query(Focus)
            .join(FocusTodoLink, FocusTodoLink.focus_id == Focus.id)
            .filter(FocusTodoLink.todo_id == todo_id)
            .order_by(Focus.sort_order, Focus.id)
            .all()
        )


def serialize_todo(t: Todo) -> dict[str, Any]:
    return {
        "id": t.id,
        "text": t.text,
        "subtitle": t.subtitle,
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "done": bool(t.done),
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "sort_order": t.sort_order,
        "source_note_id": t.source_note_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


todo_service = TodoService()
