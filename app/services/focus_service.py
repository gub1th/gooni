"""Focus CRUD over the dedicated `focuses` table.

Focuses are long-running commitments. Each carries endgoal / health /
confidence / scale / status / start_at / end_at / committed and a
`color` for the dot system that visually links to its todos.

After the dashboard revamp:
  - is_primary moved to Todo (todos are the active-execution layer).
  - focus_todo_links M2M dropped; todo links via the single
    `todos.focus_id` FK.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, Todo
from .list_service import _item_embed_text, list_service


# 10-color palette mirroring the migration. New focuses cycle through
# this in creation order.
_COLOR_PALETTE = [
    "#22C55E", "#3B82F6", "#F59E0B", "#A855F7", "#EF4444",
    "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#14B8A6",
]


def _next_color(db: Session) -> str:
    n = db.query(Focus).count()
    return _COLOR_PALETTE[n % len(_COLOR_PALETTE)]


class FocusService:
    def get(self, db: Session, focus_id: int) -> Focus | None:
        return db.query(Focus).filter(Focus.id == focus_id).first()

    def list_active(self, db: Session) -> list[Focus]:
        return (
            db.query(Focus)
            .filter(Focus.done.is_(False))
            .order_by(Focus.sort_order, Focus.id)
            .all()
        )

    def create(
        self,
        db: Session,
        text: str,
        endgoal: str | None = None,
        committed: bool = False,
        source_note_id: int | None = None,
        status: str | None = None,
        scale: str | None = None,
        health: int | None = None,
        confidence: int | None = None,
        start_at: datetime | None = None,
        end_at: datetime | None = None,
        subtitle: str | None = None,
        color: str | None = None,
    ) -> Focus:
        max_order = (
            db.query(Focus.sort_order)
            .order_by(Focus.sort_order.desc())
            .first()
        )
        next_order = (max_order[0] + 1) if max_order else 1

        if status is None:
            status = "committed" if committed else "someday"

        embed_raw = _item_embed_text(text, endgoal)
        embed_vec = list_service._embed_item_text(embed_raw)

        f = Focus(
            text=text.strip(),
            subtitle=subtitle,
            endgoal=(endgoal or None),
            committed=bool(committed),
            status=status,
            scale=scale,
            color=color or _next_color(db),
            health=health,
            confidence=confidence,
            start_at=start_at,
            end_at=end_at,
            sort_order=next_order,
            source_note_id=source_note_id,
            embedding=json.dumps(embed_vec) if embed_vec else None,
        )
        db.add(f)
        db.commit()
        db.refresh(f)
        return f

    def update(self, db: Session, focus_id: int, **patch: Any) -> Focus | None:
        f = self.get(db, focus_id)
        if not f:
            return None
        for key in (
            "text", "endgoal", "subtitle", "committed", "done",
            "status", "scale", "color", "health", "confidence",
            "start_at", "end_at", "sort_order",
        ):
            if key in patch:
                setattr(f, key, patch[key])
        if "done" in patch:
            f.completed_at = datetime.utcnow() if patch["done"] else None
        if "status" in patch:
            f.committed = patch["status"] == "committed"
        elif "committed" in patch and f.status is None:
            f.status = "committed" if patch["committed"] else "someday"
        if any(k in patch for k in ("text", "endgoal", "subtitle")):
            embed_raw = _item_embed_text(f.text, f.endgoal or f.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                f.embedding = json.dumps(vec)
        db.commit()
        db.refresh(f)
        return f

    def delete(self, db: Session, focus_id: int) -> bool:
        f = self.get(db, focus_id)
        if not f:
            return False
        # Clear focus_id on any linked todos so they survive as
        # focus-less rows. Cleaner than cascading the delete to todos
        # (which would surprise the user — "I deleted a focus and lost
        # my todos").
        db.query(Todo).filter(Todo.focus_id == focus_id).update(
            {"focus_id": None}, synchronize_session=False
        )
        db.delete(f)
        db.commit()
        return True

    def reorder(self, db: Session, ordered_ids: list[int]) -> None:
        for idx, fid in enumerate(ordered_ids):
            db.query(Focus).filter(Focus.id == fid).update(
                {"sort_order": idx}, synchronize_session=False
            )
        db.commit()

    def linked_todos(self, db: Session, focus_id: int) -> list[Todo]:
        return (
            db.query(Todo)
            .filter(Todo.focus_id == focus_id)
            .order_by(Todo.sort_order, Todo.id)
            .all()
        )

    def get_active_context(self, db: Session) -> str:
        """Plain-text block for system-prompt injection — committed focuses
        with their endgoals.
        """
        rows = (
            db.query(Focus)
            .filter(Focus.done.is_(False), Focus.committed.is_(True))
            .order_by(Focus.sort_order, Focus.id)
            .limit(5)
            .all()
        )
        if not rows:
            return ""
        lines = ["Daniel's active focuses:"]
        for f in rows:
            endgoal = f.endgoal or ""
            lines.append(f"- {f.text}" + (f": {endgoal}" if endgoal else ""))
        return "\n".join(lines)


def serialize_focus(f: Focus) -> dict[str, Any]:
    return {
        "id": f.id,
        "text": f.text,
        "subtitle": f.subtitle,
        "endgoal": f.endgoal,
        "committed": bool(f.committed),
        "done": bool(f.done),
        "status": f.status,
        "scale": f.scale,
        "color": f.color,
        "health": f.health,
        "confidence": f.confidence,
        "start_at": f.start_at.isoformat() if f.start_at else None,
        "end_at": f.end_at.isoformat() if f.end_at else None,
        "completed_at": f.completed_at.isoformat() if f.completed_at else None,
        "sort_order": f.sort_order,
        "source_note_id": f.source_note_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


focus_service = FocusService()
