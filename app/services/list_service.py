import re
from datetime import datetime

from ..db.models import Note, Space


class ListService:
    def find_or_create_lists_space(self, db) -> Space:
        space = db.query(Space).filter(Space.name == "Lists").first()
        if not space:
            space = Space(name="Lists", emoji="📋")
            db.add(space)
            db.commit()
            db.refresh(space)
        return space

    def get_all_lists(self, db) -> list:
        space = db.query(Space).filter(Space.name == "Lists").first()
        if not space:
            return []
        return db.query(Note).filter(Note.space_id == space.id).all()

    def get_list_context(self, db) -> str:
        lists = self.get_all_lists(db)
        if not lists:
            return ""
        names = ", ".join(note.title for note in lists if note.title)
        return f"Your lists: {names}"

    def find_list(self, list_name: str, db) -> Note | None:
        space = db.query(Space).filter(Space.name == "Lists").first()
        if not space:
            return None
        return (
            db.query(Note)
            .filter(
                Note.space_id == space.id,
                Note.title.ilike(list_name),
            )
            .first()
        )

    def add_item(self, list_name: str, item: str, db) -> str:
        space = self.find_or_create_lists_space(db)

        note = (
            db.query(Note)
            .filter(Note.space_id == space.id, Note.title.ilike(list_name))
            .first()
        )

        new_item_html = f"<li><p>{item}</p></li>"

        if note is None:
            note = Note(
                title=list_name,
                content=f"<ul>{new_item_html}</ul>",
                space_id=space.id,
            )
            db.add(note)
        else:
            content = note.content or ""
            if "</ul>" in content:
                note.content = content.replace("</ul>", f"{new_item_html}</ul>", 1)
            else:
                note.content = f"<ul>{new_item_html}</ul>"
            note.updated_at = datetime.utcnow()

        db.commit()
        return f"Added \"{item}\" to {list_name}."

    def show_list(self, list_name: str, db) -> str:
        note = self.find_list(list_name, db)
        if not note:
            return f"No list named \"{list_name}\" found."
        content = note.content or ""
        items = re.findall(r"<li><p>(.*?)</p></li>", content)
        if not items:
            return f"{note.title}:\n(empty)"
        lines = "\n".join(f"• {i}" for i in items)
        return f"{note.title}:\n{lines}"


list_service = ListService()
