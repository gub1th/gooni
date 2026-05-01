"""Item service — unified focus + todo over the ListItem model.

Replaces app/services/focus_service.py and the legacy /todos route logic.
A "focus" is a top-level ListItem with `endgoal` set; a "todo" is any
leaf ListItem. Same component, same table, different shape.

Top-level focus items live under the canonical "Focuses" List
(type=focus). Inbox todos with no parent live under the canonical
"Todo list" (type=todo) — that's what list_service already manages.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import List as ListModel, ListItem
from .list_service import _item_embed_text, list_service


_FOCUS_LIST_NAME = "Focuses"
_FOCUS_LIST_TYPE = "focus"
_TODO_LIST_NAME = "Todo list"
_TODO_LIST_TYPE = "todo"
_STALE_DAYS = 7


class ItemService:
    # ── List bootstrap ──────────────────────────────────────────────────

    def _get_or_create_list(
        self, db: Session, name: str, type_: str
    ) -> ListModel:
        existing = (
            db.query(ListModel).filter(ListModel.type == type_).order_by(ListModel.id.asc()).first()
        )
        if existing:
            return existing
        row = ListModel(name=name, type=type_)
        db.add(row)
        db.commit()
        db.refresh(row)
        return row

    def get_focus_list(self, db: Session) -> ListModel:
        return self._get_or_create_list(db, _FOCUS_LIST_NAME, _FOCUS_LIST_TYPE)

    def get_todo_list(self, db: Session) -> ListModel:
        return self._get_or_create_list(db, _TODO_LIST_NAME, _TODO_LIST_TYPE)

    # ── CRUD ────────────────────────────────────────────────────────────

    def get(self, db: Session, item_id: int) -> ListItem | None:
        return db.query(ListItem).filter(ListItem.id == item_id).first()

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
    ) -> ListItem:
        if parent_id is not None:
            parent = self.get(db, parent_id)
            if not parent:
                raise ValueError(f"parent_id {parent_id} not found")
            list_id = parent.list_id
        else:
            # Top-level routing: anything the caller marked as a focus (committed
            # OR has an endgoal) lands in the focus list so it shows up in
            # tree.focuses. Bare "todo"-style adds go to the inbox todo list.
            is_focus = bool(committed) or bool(endgoal)
            list_obj = self.get_focus_list(db) if is_focus else self.get_todo_list(db)
            list_id = list_obj.id

        # Append to siblings.
        sibling_q = db.query(ListItem).filter(ListItem.list_id == list_id)
        if parent_id is None:
            sibling_q = sibling_q.filter(ListItem.parent_id.is_(None))
        else:
            sibling_q = sibling_q.filter(ListItem.parent_id == parent_id)
        max_order = max((s.sort_order for s in sibling_q.all()), default=0)

        # Default status mirrors committed if caller didn't specify — keeps
        # legacy callers and the unified extractor working without a flag.
        if status is None:
            status = "committed" if committed else "someday"
        # Embed up-front so the row is immediately searchable by the
        # conflict-detection / similarity helpers. Best-effort — failures
        # don't block the insert.
        embed_raw = _item_embed_text(text, endgoal)
        embed_vec = list_service._embed_item_text(embed_raw)
        item = ListItem(
            list_id=list_id,
            parent_id=parent_id,
            text=text.strip(),
            endgoal=(endgoal or None),
            committed=bool(committed),
            due_date=due_date,
            source_note_id=source_note_id,
            sort_order=max_order + 1,
            status=status,
            scale=scale,
            embedding=json.dumps(embed_vec) if embed_vec else None,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def update(self, db: Session, item_id: int, **patch: Any) -> ListItem | None:
        item = self.get(db, item_id)
        if not item:
            return None
        if patch.get("is_primary") is True:
            # Singleton: clear any existing primary before setting this one.
            db.query(ListItem).filter(
                ListItem.is_primary.is_(True), ListItem.id != item_id
            ).update({"is_primary": False}, synchronize_session=False)
        for key in (
            "text",
            "endgoal",
            "committed",
            "done",
            "actionable",
            "is_primary",
            "due_date",
            "subtitle",
            "sort_order",
            "parent_id",
            "status",
            "scale",
        ):
            if key in patch:
                setattr(item, key, patch[key])
        if "done" in patch:
            item.completed_at = datetime.utcnow() if patch["done"] else None
        # Keep `committed` and `status` consistent — they're two views of
        # the same engagement axis. Caller patches one, we sync the other.
        if "status" in patch:
            item.committed = patch["status"] in ("committed", "pending")
        elif "committed" in patch and item.status is None:
            item.status = "committed" if patch["committed"] else "someday"
        if patch.get("actionable") is False:
            # Flipping to idea clears completion state.
            item.done = False
            item.completed_at = None
        # Re-embed on text/endgoal/subtitle edits so similarity hits stay
        # accurate after rewords.
        if any(k in patch for k in ("text", "endgoal", "subtitle")):
            embed_raw = _item_embed_text(item.text, item.endgoal or item.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                item.embedding = json.dumps(vec)
        db.commit()
        db.refresh(item)
        return item

    def delete(self, db: Session, item_id: int) -> bool:
        """Cascade-delete this item and all descendants. SQLite SQLAlchemy
        doesn't follow self-FKs as ON DELETE CASCADE without explicit
        wiring, so we walk the tree manually.
        """
        item = self.get(db, item_id)
        if not item:
            return False
        ids_to_delete = [item.id]
        cursor = [item.id]
        while cursor:
            children = (
                db.query(ListItem)
                .filter(ListItem.parent_id.in_(cursor))
                .all()
            )
            cursor = [c.id for c in children]
            ids_to_delete.extend(cursor)
        db.query(ListItem).filter(ListItem.id.in_(ids_to_delete)).delete(
            synchronize_session=False
        )
        db.commit()
        return True

    def reorder(self, db: Session, ordered_ids: list[int]) -> None:
        """Set sort_order to the index in `ordered_ids` for each id present."""
        for idx, item_id in enumerate(ordered_ids):
            db.query(ListItem).filter(ListItem.id == item_id).update(
                {"sort_order": idx}
            )
        db.commit()

    # ── Tree + derived views ────────────────────────────────────────────

    def list_tree(self, db: Session) -> dict[str, Any]:
        """Return all items grouped into focus / inbox top-levels with
        children nested. Shape:
          { "focuses": [ItemTree...], "inbox": [ItemTree...] }
        ItemTree adds: progress {done, total}, stale (bool), children.
        """
        focus_list = self.get_focus_list(db)
        todo_list = self.get_todo_list(db)

        # One scan, build by list_id.
        items_by_list: dict[int, list[ListItem]] = {focus_list.id: [], todo_list.id: []}
        for it in (
            db.query(ListItem)
            .filter(ListItem.list_id.in_([focus_list.id, todo_list.id]))
            .order_by(ListItem.sort_order, ListItem.id)
            .all()
        ):
            items_by_list.setdefault(it.list_id, []).append(it)

        return {
            "focuses": self._build_subtree(items_by_list[focus_list.id], parent_id=None),
            "inbox": self._build_subtree(items_by_list[todo_list.id], parent_id=None),
        }

    def _build_subtree(
        self, items: list[ListItem], parent_id: int | None
    ) -> list[dict[str, Any]]:
        # Group by parent_id once, then recurse.
        by_parent: dict[int | None, list[ListItem]] = {}
        for it in items:
            by_parent.setdefault(it.parent_id, []).append(it)

        def render(node: ListItem) -> dict[str, Any]:
            children_models = sorted(
                by_parent.get(node.id, []), key=lambda x: (x.sort_order, x.id)
            )
            children = [render(c) for c in children_models]
            descendants_done = sum(1 for c in _walk(node.id, by_parent) if c.done)
            descendants_total = sum(1 for _ in _walk(node.id, by_parent))
            stale_cutoff = datetime.utcnow() - timedelta(days=_STALE_DAYS)
            updated = node.updated_at or node.created_at
            stale = bool(updated and updated < stale_cutoff)
            return {
                **_serialize(node),
                "children": children,
                "progress": {"done": descendants_done, "total": descendants_total},
                "stale": stale,
            }

        roots = sorted(
            by_parent.get(parent_id, []), key=lambda x: (x.sort_order, x.id)
        )
        return [render(r) for r in roots]

    def today(self, db: Session) -> list[dict[str, Any]]:
        """Leaves (no children) that are: due today, OR undated leaves
        whose top-level ancestor is committed, OR inbox leaves with no
        parent. Open only — done leaves are excluded.

        Returns flat list of items decorated with `parent_chain` (list of
        ancestor names from top-level down) for context badges.
        """
        focus_list = self.get_focus_list(db)
        todo_list = self.get_todo_list(db)
        all_items = (
            db.query(ListItem)
            .filter(ListItem.list_id.in_([focus_list.id, todo_list.id]))
            .order_by(ListItem.sort_order, ListItem.id)
            .all()
        )
        by_id = {it.id: it for it in all_items}
        children_of: dict[int, list[ListItem]] = {}
        for it in all_items:
            if it.parent_id is not None:
                children_of.setdefault(it.parent_id, []).append(it)

        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)

        def top_ancestor(it: ListItem) -> ListItem:
            cursor = it
            while cursor.parent_id is not None and cursor.parent_id in by_id:
                cursor = by_id[cursor.parent_id]
            return cursor

        def parent_chain(it: ListItem) -> list[str]:
            chain: list[str] = []
            cursor = it
            while cursor.parent_id is not None and cursor.parent_id in by_id:
                cursor = by_id[cursor.parent_id]
                chain.append(cursor.text)
            return list(reversed(chain))

        out: list[dict[str, Any]] = []
        for it in all_items:
            if it.done:
                continue
            if children_of.get(it.id):
                continue  # not a leaf — focus/checklist parent
            include = False
            if it.due_date and today_start <= it.due_date < today_end:
                include = True
            elif it.due_date is None:
                top = top_ancestor(it)
                if top.id == it.id and it.list_id == todo_list.id:
                    include = True  # inbox todo
                elif top.committed and top.id != it.id:
                    include = True  # leaf strictly under a committed focus
            if include:
                out.append({**_serialize(it), "parent_chain": parent_chain(it)})
        return out

    # ── Orchestrator context ────────────────────────────────────────────

    def get_active_context(self, db: Session) -> str:
        """Plain-text block for system-prompt injection — replaces
        focus_service.get_focus_context. Lists committed top-level
        focuses with their endgoals + a brief progress note.
        """
        tree = self.list_tree(db)
        focuses = [f for f in tree["focuses"] if f.get("committed")]
        if not focuses:
            return ""
        lines = ["Daniel's active focuses:"]
        for f in focuses[:5]:
            prog = f["progress"]
            stale_marker = " (stale)" if f["stale"] else ""
            progress_str = (
                f" — {prog['done']}/{prog['total']}" if prog["total"] else ""
            )
            endgoal = f.get("endgoal") or ""
            lines.append(
                f"- {f['text']}{progress_str}{stale_marker}"
                + (f": {endgoal}" if endgoal else "")
            )
        return "\n".join(lines)


def _walk(node_id: int, by_parent: dict[int | None, list[ListItem]]):
    """Yield every descendant of node_id depth-first."""
    cursor = list(by_parent.get(node_id, []))
    while cursor:
        nxt: list[ListItem] = []
        for c in cursor:
            yield c
            nxt.extend(by_parent.get(c.id, []))
        cursor = nxt


def _serialize(it: ListItem) -> dict[str, Any]:
    return {
        "id": it.id,
        "list_id": it.list_id,
        "parent_id": it.parent_id,
        "text": it.text,
        "subtitle": it.subtitle,
        "endgoal": it.endgoal,
        "committed": bool(it.committed),
        "done": bool(it.done),
        "actionable": bool(it.actionable),
        "is_primary": bool(it.is_primary),
        "status": it.status,
        "scale": it.scale,
        "due_date": it.due_date.isoformat() if it.due_date else None,
        "completed_at": it.completed_at.isoformat() if it.completed_at else None,
        "sort_order": it.sort_order,
        "source_note_id": it.source_note_id,
        "created_at": it.created_at.isoformat() if it.created_at else None,
        "updated_at": it.updated_at.isoformat() if it.updated_at else None,
    }


item_service = ItemService()
