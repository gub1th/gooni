"""CRUD over List + ListItem rows.

Replaces the prior TipTap-HTML-mutating implementation. Items are now real
DB rows, not <li> tags inside a Note's content. UI variations (todo vs
backlog vs generic) are driven by `List.type` — storage stays uniform.

Three known list types:
  todo    — the single canonical user todo list (date pills, drag reorder)
  backlog — auto-logged feature requests from chat + note classifier
  generic — anything user-created (shopping, reading, etc.)

`get_list_context` is what the orchestrator injects into the system prompt
so the LLM knows which list names exist and can pick exact matches when
calling `add_to_list` / `show_list` tools.
"""

from datetime import datetime

from sqlalchemy import func as sqlfunc
from sqlalchemy.orm import Session

from ..db.models import List, ListItem


_TODO_LIST_NAME = "Todo list"
_BACKLOG_LIST_NAME = "Gooni Backlog"


class ListService:
    # ── lookup ──────────────────────────────────────────────────────────

    def find_list_by_name(self, name: str, db: Session) -> List | None:
        return (
            db.query(List)
            .filter(List.name.ilike(name))
            .first()
        )

    def find_list_by_type(self, type_: str, db: Session) -> List | None:
        """For singletons like the canonical todo + backlog lists."""
        return (
            db.query(List)
            .filter(List.type == type_)
            .order_by(List.id.asc())
            .first()
        )

    def get_all_lists(self, db: Session) -> list[List]:
        return db.query(List).order_by(List.sort_order, List.id).all()

    # ── creation / get-or-create ────────────────────────────────────────

    def get_or_create_list(
        self,
        name: str,
        type_: str = "generic",
        emoji: str | None = None,
        db: Session | None = None,
    ) -> List:
        if db is None:
            raise ValueError("db session required")
        existing = self.find_list_by_name(name, db)
        if existing:
            return existing
        max_order = db.query(sqlfunc.max(List.sort_order)).scalar() or 0
        lst = List(name=name, type=type_, emoji=emoji, sort_order=max_order + 1)
        db.add(lst)
        db.commit()
        db.refresh(lst)
        return lst

    def get_or_create_todo_list(self, db: Session) -> List:
        existing = self.find_list_by_type("todo", db)
        if existing:
            return existing
        return self.get_or_create_list(_TODO_LIST_NAME, "todo", "📋", db)

    def get_or_create_backlog_list(self, db: Session) -> List:
        existing = self.find_list_by_type("backlog", db)
        if existing:
            return existing
        return self.get_or_create_list(_BACKLOG_LIST_NAME, "backlog", "🛠", db)

    # ── items ────────────────────────────────────────────────────────────

    def get_items(self, list_id: int, db: Session) -> list[ListItem]:
        return (
            db.query(ListItem)
            .filter(ListItem.list_id == list_id)
            .order_by(ListItem.sort_order, ListItem.id)
            .all()
        )

    def add_item(
        self,
        list_id: int,
        text: str,
        db: Session,
        subtitle: str | None = None,
        due_date: datetime | None = None,
        source_note_id: int | None = None,
        actionable: bool = True,
    ) -> ListItem:
        max_order = (
            db.query(sqlfunc.max(ListItem.sort_order))
            .filter(ListItem.list_id == list_id)
            .scalar()
            or 0
        )
        item = ListItem(
            list_id=list_id,
            text=text,
            subtitle=subtitle,
            sort_order=max_order + 1,
            due_date=due_date,
            source_note_id=source_note_id,
            actionable=actionable,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def add_item_by_list_name(
        self,
        list_name: str,
        text: str,
        db: Session,
        type_default: str = "generic",
        emoji_default: str | None = None,
        subtitle: str | None = None,
        source_note_id: int | None = None,
    ) -> tuple[List, ListItem]:
        """Convenience for LLM tools — find or create list by name, then append."""
        lst = self.get_or_create_list(list_name, type_default, emoji_default, db)
        item = self.add_item(
            lst.id, text, db, subtitle=subtitle, source_note_id=source_note_id
        )
        return lst, item

    def update_item(
        self,
        item_id: int,
        db: Session,
        text: str | None = None,
        subtitle: str | None = None,
        done: bool | None = None,
        actionable: bool | None = None,
        is_primary: bool | None = None,
        due_date: datetime | None = None,
        sort_order: int | None = None,
    ) -> ListItem | None:
        item = db.query(ListItem).filter(ListItem.id == item_id).first()
        if item is None:
            return None
        if text is not None:
            item.text = text
        if subtitle is not None:
            item.subtitle = subtitle
        if done is not None:
            item.done = done
            item.completed_at = datetime.utcnow() if done else None
        if actionable is not None:
            item.actionable = bool(actionable)
            # Idea rows can't be "done" — clear stale state when flipping to idea.
            if not actionable:
                item.done = False
                item.completed_at = None
        if is_primary is not None:
            if is_primary:
                # Singleton: clear any existing primary before setting this one.
                db.query(ListItem).filter(
                    ListItem.is_primary.is_(True), ListItem.id != item_id
                ).update({"is_primary": False}, synchronize_session=False)
            item.is_primary = bool(is_primary)
        if due_date is not None:
            item.due_date = due_date
        if sort_order is not None:
            item.sort_order = sort_order
        db.commit()
        db.refresh(item)
        return item

    def delete_item(self, item_id: int, db: Session) -> bool:
        item = db.query(ListItem).filter(ListItem.id == item_id).first()
        if item is None:
            return False
        db.delete(item)
        db.commit()
        return True

    def reorder_items(self, ordered_ids: list[int], db: Session) -> None:
        """Set sort_order = position for each id in the list. Caller pre-sorts."""
        for position, item_id in enumerate(ordered_ids):
            db.query(ListItem).filter(ListItem.id == item_id).update(
                {"sort_order": position}
            )
        db.commit()

    # ── prompt context ──────────────────────────────────────────────────

    def get_list_context(self, db: Session) -> str:
        """Inline string injected into the system prompt so the LLM picks
        exact list names when calling the add_to_list / show_list tools."""
        lists = self.get_all_lists(db)
        if not lists:
            return ""
        names = ", ".join(f'"{lst.name}"' for lst in lists)
        return f"Your lists: {names}"

    def show_list(self, list_name: str, db: Session) -> str:
        """For the show_list LLM tool. Plain-text rendering."""
        lst = self.find_list_by_name(list_name, db)
        if lst is None:
            return f'No list named "{list_name}" found.'
        items = self.get_items(lst.id, db)
        if not items:
            return f"{lst.name}:\n(empty)"
        lines = []
        for it in items:
            check = "✓" if it.done else "•"
            line = f"{check} {it.text}"
            if it.subtitle:
                line += f" — {it.subtitle}"
            lines.append(line)
        return f"{lst.name}:\n" + "\n".join(lines)


list_service = ListService()
