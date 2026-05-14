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

import json
import math
from datetime import datetime

from sqlalchemy import func as sqlfunc
from sqlalchemy.orm import Session

from ..db.models import List, ListItem
from ..llm.client import llm_client


_TODO_LIST_NAME = "Todo list"
_BACKLOG_LIST_NAME = "Gooni Backlog"

# Cosine-similarity thresholds for the conflict detector.
# - HIGH: caller (UI / agent) should treat this as a probable duplicate and
#   surface a merge/skip prompt instead of silently inserting again.
# - MEDIUM: weaker match — return as a hint but still safe to insert.
CONFLICT_HIGH = 0.88
CONFLICT_MEDIUM = 0.78


def _cosine(vec1: list[float], vec2: list[float]) -> float:
    if not vec1 or not vec2:
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    mag1 = math.sqrt(sum(a * a for a in vec1))
    mag2 = math.sqrt(sum(b * b for b in vec2))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    return dot / (mag1 * mag2)


def _item_embed_text(text: str, subtitle: str | None) -> str:
    """Canonical string we feed the embedder for an item. Includes subtitle
    so two items with the same headline but different `Why:` rationales don't
    falsely collide."""
    parts = [text or ""]
    if subtitle:
        parts.append(subtitle)
    return "\n".join(p.strip() for p in parts if p and p.strip())


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
        # No emoji default — frontend ListIcon resolves a lucide icon by type.
        return self.get_or_create_list(_TODO_LIST_NAME, "todo", None, db)

    def get_or_create_backlog_list(self, db: Session) -> List:
        existing = self.find_list_by_type("backlog", db)
        if existing:
            return existing
        return self.get_or_create_list(_BACKLOG_LIST_NAME, "backlog", None, db)

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
        source_note_id: int | None = None,
        actionable: bool = True,
        embedding: list[float] | None = None,
    ) -> ListItem:
        """Insert. If `embedding` is provided we store it; otherwise we try to
        generate one synchronously so future conflict checks have something to
        compare against. Embedding failures are non-fatal — the row still
        inserts."""
        max_order = (
            db.query(sqlfunc.max(ListItem.sort_order))
            .filter(ListItem.list_id == list_id)
            .scalar()
            or 0
        )
        if embedding is None:
            embedding = self._embed_item_text(_item_embed_text(text, subtitle))
        item = ListItem(
            list_id=list_id,
            text=text,
            subtitle=subtitle,
            sort_order=max_order + 1,
            source_note_id=source_note_id,
            actionable=actionable,
            embedding=json.dumps(embedding) if embedding else None,
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    # ── conflict detection ──────────────────────────────────────────────

    def _embed_item_text(self, raw: str) -> list[float] | None:
        """Wrap llm_client.generate_embedding so callers stay synchronous and
        ignore failures gracefully."""
        if not raw:
            return None
        try:
            embedding, _ = llm_client.generate_embedding(raw)
            return embedding or None
        except Exception as e:
            print(f"List item embedding error: {e}")
            return None

    def find_similar_in_list(
        self,
        list_id: int,
        text: str,
        db: Session,
        subtitle: str | None = None,
        threshold: float = CONFLICT_MEDIUM,
        limit: int = 5,
        include_done: bool = False,
        exclude_item_id: int | None = None,
    ) -> list[tuple[ListItem, float]]:
        """Cosine-search existing items in `list_id` against `text` (+optional
        subtitle). Returns (item, similarity) pairs sorted desc, filtered to
        sim >= threshold. Items with no embedding are skipped silently."""
        raw = _item_embed_text(text, subtitle)
        query_vec = self._embed_item_text(raw)
        if not query_vec:
            return []
        # Score with a (id, embedding) tuple query so the deferred embedding
        # column is the only thing pulled — no full-row hydration. Then load
        # only the top-K full ListItems by id for the caller.
        q = (
            db.query(ListItem.id, ListItem.embedding)
            .filter(ListItem.list_id == list_id, ListItem.embedding.isnot(None))
        )
        if exclude_item_id is not None:
            q = q.filter(ListItem.id != exclude_item_id)
        if not include_done:
            q = q.filter(ListItem.done.is_(False))
        scored: list[tuple[int, float]] = []
        for iid, emb in q.all():
            try:
                sim = _cosine(query_vec, json.loads(emb))
            except Exception:
                continue
            if sim >= threshold:
                scored.append((iid, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        top = scored[:limit]
        if not top:
            return []
        ids = [iid for iid, _ in top]
        rows = db.query(ListItem).filter(ListItem.id.in_(ids)).all()
        by_id = {r.id: r for r in rows}
        return [(by_id[iid], sim) for iid, sim in top if iid in by_id]

    def add_item_with_conflict_check(
        self,
        list_id: int,
        text: str,
        db: Session,
        subtitle: str | None = None,
        source_note_id: int | None = None,
        actionable: bool = True,
        threshold: float = CONFLICT_MEDIUM,
    ) -> tuple[ListItem, list[tuple[ListItem, float]]]:
        """Embed once, run conflict scan against existing items, then insert
        (reusing the same embedding so we don't pay for two OpenAI calls).
        Returns (inserted_item, conflicts). Caller decides whether to keep,
        delete, or merge based on conflict severity (CONFLICT_HIGH vs MEDIUM).
        """
        raw = _item_embed_text(text, subtitle)
        query_vec = self._embed_item_text(raw)
        conflicts: list[tuple[ListItem, float]] = []
        if query_vec:
            scored: list[tuple[int, float]] = []
            existing = (
                db.query(ListItem.id, ListItem.embedding)
                .filter(
                    ListItem.list_id == list_id,
                    ListItem.embedding.isnot(None),
                    ListItem.done.is_(False),
                )
                .all()
            )
            for iid, emb in existing:
                try:
                    sim = _cosine(query_vec, json.loads(emb))
                except Exception:
                    continue
                if sim >= threshold:
                    scored.append((iid, sim))
            scored.sort(key=lambda x: x[1], reverse=True)
            top = scored[:5]
            if top:
                ids = [iid for iid, _ in top]
                rows = db.query(ListItem).filter(ListItem.id.in_(ids)).all()
                by_id = {r.id: r for r in rows}
                conflicts = [(by_id[iid], sim) for iid, sim in top if iid in by_id]
        item = self.add_item(
            list_id,
            text,
            db,
            subtitle=subtitle,
            source_note_id=source_note_id,
            actionable=actionable,
            embedding=query_vec,
        )
        return item, conflicts[:5]

    def update_item_embedding(self, item_id: int, db: Session) -> None:
        """Re-embed an item's text+subtitle and persist. Called after edits
        that change the searchable content. Best-effort: failures are logged
        and swallowed."""
        item = db.query(ListItem).filter(ListItem.id == item_id).first()
        if item is None:
            return
        raw = _item_embed_text(item.text, item.subtitle)
        vec = self._embed_item_text(raw)
        if vec:
            item.embedding = json.dumps(vec)
            db.commit()

    def backfill_missing_embeddings(self, db: Session, limit: int = 200) -> int:
        """Embed up to `limit` rows that don't have an embedding yet. Returns
        how many we successfully populated. Cheap loop on top of the existing
        embedder so a startup hook can chip away at backlog over restarts."""
        rows = (
            db.query(ListItem)
            .filter(ListItem.embedding.is_(None))
            .order_by(ListItem.id.asc())
            .limit(limit)
            .all()
        )
        wrote = 0
        for it in rows:
            raw = _item_embed_text(it.text, it.subtitle)
            vec = self._embed_item_text(raw)
            if vec:
                it.embedding = json.dumps(vec)
                wrote += 1
        if wrote:
            db.commit()
        return wrote

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
        sort_order: int | None = None,
    ) -> ListItem | None:
        # Focus / todo / backlog field-handling moved out — those live in
        # focuses / todos / backlog_tickets tables now (see focus_service /
        # todo_service / backlog_service). list_items keeps only generic
        # text + subtitle + done + actionable + sort_order.
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
            if not actionable:
                item.done = False
                item.completed_at = None
        if sort_order is not None:
            item.sort_order = sort_order
        # If the searchable text changed, re-embed so future conflict scans
        # match the new content. Skip if neither field was touched.
        if text is not None or subtitle is not None:
            raw = _item_embed_text(item.text, item.subtitle)
            vec = self._embed_item_text(raw)
            if vec:
                item.embedding = json.dumps(vec)
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
