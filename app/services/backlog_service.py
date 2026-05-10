"""Backlog ticket CRUD over the dedicated `backlog_tickets` table.

Each ticket = one PR-or-feature-shaped chunk of engineering work. Carries
board_status (todo / in_progress / done) + pr_url for the Jira-style
3-column dashboard board. Sourced from notes via source_note_id when
classify_note flags a feature_request signal.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import BacklogTicket
from .list_service import _item_embed_text, list_service


class BacklogService:
    def get(self, db: Session, ticket_id: int) -> BacklogTicket | None:
        return db.query(BacklogTicket).filter(BacklogTicket.id == ticket_id).first()

    def list_all(self, db: Session, include_done: bool = True) -> list[BacklogTicket]:
        q = db.query(BacklogTicket).order_by(BacklogTicket.sort_order, BacklogTicket.id)
        if not include_done:
            q = q.filter(BacklogTicket.done.is_(False))
        return q.all()

    def create(
        self,
        db: Session,
        text: str,
        subtitle: str | None = None,
        source_note_id: int | None = None,
        board_status: str | None = None,
    ) -> BacklogTicket:
        # Idempotent on (source_note_id) — repeated "tag to backlog" clicks
        # from the same note return the existing open ticket instead of
        # stacking duplicates. Only matches non-done tickets so a closed
        # ticket on the same note doesn't block re-opening the work.
        if source_note_id is not None:
            existing = (
                db.query(BacklogTicket)
                .filter(
                    BacklogTicket.source_note_id == source_note_id,
                    BacklogTicket.done.is_(False),
                )
                .order_by(BacklogTicket.id.desc())
                .first()
            )
            if existing is not None:
                return existing

        max_order = (
            db.query(BacklogTicket.sort_order)
            .order_by(BacklogTicket.sort_order.desc())
            .first()
        )
        next_order = (max_order[0] + 1) if max_order else 1

        embed_raw = _item_embed_text(text, subtitle)
        embed_vec = list_service._embed_item_text(embed_raw)

        t = BacklogTicket(
            text=text.strip(),
            subtitle=subtitle,
            board_status=board_status,
            sort_order=next_order,
            source_note_id=source_note_id,
            embedding=json.dumps(embed_vec) if embed_vec else None,
        )
        db.add(t)
        db.commit()
        db.refresh(t)
        return t

    def update(self, db: Session, ticket_id: int, **patch: Any) -> BacklogTicket | None:
        t = self.get(db, ticket_id)
        if not t:
            return None
        for key in (
            "text", "subtitle", "board_status", "pr_url", "done", "sort_order",
            "todo_id",
        ):
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

    def delete(self, db: Session, ticket_id: int) -> bool:
        t = self.get(db, ticket_id)
        if not t:
            return False
        db.delete(t)
        db.commit()
        return True

    def promote(self, db: Session, ticket_id: int) -> tuple[BacklogTicket, "Todo"] | None:
        """Create a Todo mirroring this ticket's text/subtitle and link
        them via ticket.todo_id. Idempotent — re-promoting an already-
        linked ticket returns the existing pair.
        """
        from .todo_service import todo_service
        t = self.get(db, ticket_id)
        if not t:
            return None
        if t.todo_id is not None:
            existing = todo_service.get(db, t.todo_id)
            if existing:
                return t, existing
            # Linked todo was deleted out from under us — fall through and
            # create a fresh one.
        todo = todo_service.create(
            db, text=t.text, subtitle=t.subtitle,
            source_note_id=t.source_note_id,
        )
        t.todo_id = todo.id
        db.commit()
        db.refresh(t)
        return t, todo

    def demote(self, db: Session, ticket_id: int) -> BacklogTicket | None:
        """Sever the ticket↔todo link by deleting the linked todo and
        clearing ticket.todo_id. Backlog row stays."""
        from .todo_service import todo_service
        t = self.get(db, ticket_id)
        if not t:
            return None
        if t.todo_id is not None:
            todo_service.delete(db, t.todo_id)
        t.todo_id = None
        db.commit()
        db.refresh(t)
        return t

    def find_similar(
        self, db: Session, text: str, threshold: float = 0.78, limit: int = 5
    ) -> list[tuple[BacklogTicket, float]]:
        """Return tickets with cosine similarity >= threshold, descending."""
        from .list_service import _cosine
        target = list_service._embed_item_text(text)
        if not target:
            return []
        rows = db.query(BacklogTicket.id, BacklogTicket.embedding).filter(
            BacklogTicket.embedding.is_not(None)
        ).all()
        scored: list[tuple[int, float]] = []
        for ticket_id, emb_raw in rows:
            try:
                emb = json.loads(emb_raw)
            except (TypeError, ValueError):
                continue
            sim = _cosine(target, emb)
            if sim >= threshold:
                scored.append((ticket_id, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        scored = scored[:limit]
        if not scored:
            return []
        id_set = [s[0] for s in scored]
        ticket_map = {
            t.id: t for t in db.query(BacklogTicket).filter(BacklogTicket.id.in_(id_set)).all()
        }
        return [(ticket_map[i], sim) for i, sim in scored if i in ticket_map]


def serialize_ticket(t: BacklogTicket) -> dict[str, Any]:
    return {
        "id": t.id,
        "text": t.text,
        "subtitle": t.subtitle,
        "board_status": t.board_status,
        "pr_url": t.pr_url,
        "todo_id": t.todo_id,
        "done": bool(t.done),
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "sort_order": t.sort_order,
        "source_note_id": t.source_note_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


backlog_service = BacklogService()
