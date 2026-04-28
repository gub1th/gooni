"""One-shot migration to the unified List/ListItem model.

What this does:
  1. Create List rows for each conceptual list:
       - Todo list      (type=todo)    — single canonical
       - Gooni Backlog  (type=backlog) — single canonical, starts empty
       - Places to Eat  (type=generic) — from legacy Lists-space note
  2. Copy TodoItem rows → ListItem rows under the Todo list
  3. Parse legacy Lists-space Note "Todo list" (id=88) HTML, merge unique
     items into the Todo list (dedup by lowercased text)
  4. Parse legacy Lists-space Note "Places to Eat" (id=50) HTML, copy items
  5. Delete all Notes in the "Gooni Backlog" Space (id=7)
  6. Null out Note.backlog_note_id pointers
  7. Delete the Gooni Backlog Space row

What this DOESN'T do (left for cleanup commit):
  - Drop the TodoItem / TodoNote tables (kept as data backup)
  - Drop the Note.backlog_note_id column (kept until cutover proven)
  - Delete the legacy Lists-space Notes (id=50, id=88)

Run from project root:
  source venv/bin/activate && set -a && source .env && set +a
  python scripts/migrate_to_lists.py
"""

import os
import re
import sys
from html import unescape

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.database import SessionLocal  # noqa: E402
from app.db.models import List, ListItem, Note, Space, TodoItem  # noqa: E402


def parse_tiptap_checklist(html: str) -> list[tuple[str, bool]]:
    """Extract (text, done) tuples from TipTap task list HTML.

    Matches:  <li ... data-checked="true|false" ...>...<p>TEXT</p>...</li>
    Order of attributes within <li> varies — handle both.
    """
    out: list[tuple[str, bool]] = []
    li_pattern = re.compile(
        r'<li\b([^>]*)>(.*?)</li>',
        re.IGNORECASE | re.DOTALL,
    )
    for attrs, body in li_pattern.findall(html or ""):
        checked = bool(re.search(r'data-checked\s*=\s*"true"', attrs, re.IGNORECASE))
        m = re.search(r'<p>(.*?)</p>', body, re.IGNORECASE | re.DOTALL)
        if not m:
            continue
        # Strip nested HTML tags from the text content + unescape entities
        text = re.sub(r'<[^>]+>', '', m.group(1)).strip()
        text = unescape(text)
        if text:
            out.append((text, checked))
    return out


def main() -> int:
    db = SessionLocal()
    try:
        # Idempotency guard — exit if already migrated
        if db.query(List).count() > 0:
            print("lists table already populated — refusing to re-run. Truncate manually if you want a fresh migration.")
            return 1

        # ── 1. Create singletons ────────────────────────────────────────
        todo_list = List(name="Todo list", type="todo", emoji="📋", sort_order=1)
        backlog_list = List(name="Gooni Backlog", type="backlog", emoji="🛠", sort_order=2)
        db.add(todo_list)
        db.add(backlog_list)
        db.flush()
        print(f"created Todo list (id={todo_list.id})")
        print(f"created Gooni Backlog (id={backlog_list.id})")

        # ── 2. Copy TodoItem → ListItem ─────────────────────────────────
        todos = db.query(TodoItem).order_by(TodoItem.sort_order, TodoItem.id).all()
        seen_texts: set[str] = set()
        copied = 0
        for t in todos:
            db.add(ListItem(
                list_id=todo_list.id,
                text=t.text,
                done=t.done,
                completed_at=t.completed_at,
                sort_order=t.sort_order,
                due_date=t.due_date,
                created_at=t.created_at,
            ))
            seen_texts.add(t.text.strip().lower())
            copied += 1
        print(f"copied {copied} TodoItem rows into Todo list")

        # ── 3. Merge legacy Note id=88 (Lists/Todo list) HTML ───────────
        note88 = db.query(Note).filter(Note.id == 88).first()
        merged = 0
        skipped = 0
        if note88 and note88.content:
            base_order = (
                db.query(ListItem.sort_order)
                .filter(ListItem.list_id == todo_list.id)
                .order_by(ListItem.sort_order.desc())
                .first()
            )
            next_order = (base_order[0] + 1) if base_order else 1
            for text, done in parse_tiptap_checklist(note88.content):
                if text.strip().lower() in seen_texts:
                    skipped += 1
                    continue
                db.add(ListItem(
                    list_id=todo_list.id,
                    text=text,
                    done=done,
                    sort_order=next_order,
                ))
                next_order += 1
                seen_texts.add(text.strip().lower())
                merged += 1
        print(f"merged {merged} items from legacy Note id=88 (skipped {skipped} duplicates)")

        # ── 4. Places to Eat (Note id=50) ──────────────────────────────
        note50 = db.query(Note).filter(Note.id == 50).first()
        if note50 and note50.content:
            places_list = List(name="Places to Eat", type="generic", emoji="🍜", sort_order=3)
            db.add(places_list)
            db.flush()
            count = 0
            for i, (text, done) in enumerate(parse_tiptap_checklist(note50.content)):
                db.add(ListItem(
                    list_id=places_list.id,
                    text=text,
                    done=done,
                    sort_order=i + 1,
                ))
                count += 1
            print(f"created Places to Eat (id={places_list.id}) with {count} items")
        else:
            print("Note id=50 missing — skipping Places to Eat")

        # ── 5. Delete Backlog Space contents ───────────────────────────
        backlog_space = db.query(Space).filter(Space.name == "Gooni Backlog").first()
        if backlog_space:
            backlog_notes = db.query(Note).filter(Note.space_id == backlog_space.id).all()
            print(f"deleting {len(backlog_notes)} notes from Gooni Backlog space (id={backlog_space.id})")
            for n in backlog_notes:
                db.delete(n)

            # ── 6. Null out forward pointers from source notes ─────────
            updated = (
                db.query(Note)
                .filter(Note.backlog_note_id.is_not(None))
                .update({"backlog_note_id": None}, synchronize_session=False)
            )
            print(f"nulled backlog_note_id on {updated} source notes")

            # ── 7. Drop the Backlog Space row ──────────────────────────
            db.delete(backlog_space)
            print("deleted Gooni Backlog space row")
        else:
            print("Gooni Backlog space already gone — skipping")

        db.commit()
        print("\n✓ migration committed")

        # ── Summary ────────────────────────────────────────────────────
        n_lists = db.query(List).count()
        n_items = db.query(ListItem).count()
        print(f"\nfinal state: {n_lists} lists, {n_items} list items")
        for lst in db.query(List).order_by(List.sort_order).all():
            count = db.query(ListItem).filter(ListItem.list_id == lst.id).count()
            print(f"  · [{lst.type}] {lst.name} ({count} items)")
        return 0

    except Exception as e:
        db.rollback()
        print(f"\n✗ migration failed: {e}")
        import traceback
        traceback.print_exc()
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
