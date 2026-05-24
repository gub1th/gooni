"""Todo CRUD over the dedicated `todos` table.

After the dashboard revamp, todos carry:
  - a 3-state enum (`not_yet` | `doing` | `done`) — UI cycles via two
    checkbox clicks; the legacy `done` boolean stays in sync so old
    callers reading `done` keep working.
  - `focus_id` FK (single — legacy M2M `focus_todo_links` dropped).
  - `is_primary` singleton — only one Todo across the whole table can
    have is_primary=True. Service enforces.
  - `deleted_at` soft-delete tombstone (G1 groom-mutation arc). NULL =
    live; NOT NULL = deleted at that time. All service read-paths
    filter `deleted_at IS NULL` so soft-deleted rows are invisible.
    `purge_old_deleted` hard-removes anything past 24h (sweeper runs
    in lifespan alongside daily nudge).
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from ..db.models import Focus, Settings, Todo

# FTS5 operators that need stripping before passing user input to MATCH.
# Same shape as note_service's _FTS_QUERY_STRIP.
_FTS_TODO_STRIP = re.compile(r'[\"\'()+*\-:\\^~]')
from .list_service import _item_embed_text, list_service
from . import focus_binding


# G3 mention-dedup cosine floor. On new-todo create, if the incoming
# text matches an OPEN todo above this score, we bump the existing row's
# mention_count + last_mentioned_at + mention_history instead of
# inserting a duplicate. High floor — same-language paraphrases land
# above 0.85; novel utterances stay below.
MENTION_DEDUP_FLOOR = 0.85


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _find_open_todo_for_mention(
    db: Session, embedding: list[float], floor: float = MENTION_DEDUP_FLOOR
) -> tuple[Todo | None, float]:
    """Return (todo, score) for the best OPEN (non-done, non-deleted)
    todo above the floor, or (None, 0.0) if no match clears it. Tuple
    query so deferred embeddings don't hydrate the whole row.
    """
    if not embedding:
        return (None, 0.0)
    rows = (
        db.query(Todo.id, Todo.embedding)
        .filter(
            Todo.state != "done",
            Todo.deleted_at.is_(None),
            Todo.embedding.isnot(None),
        )
        .all()
    )
    best_id: int | None = None
    best_score = 0.0
    for tid, emb_text in rows:
        try:
            emb = json.loads(emb_text)
        except Exception:
            continue
        score = _cosine(embedding, emb)
        if score >= floor and score > best_score:
            best_id = tid
            best_score = score
    if best_id is None:
        return (None, 0.0)
    return (db.query(Todo).filter(Todo.id == best_id).first(), best_score)


def _bump_mention(db: Session, todo: Todo) -> None:
    """Increment mention_count, stamp last_mentioned_at, append timestamp
    to mention_history. Caller must commit. Idempotent on a per-call
    basis but the counter intentionally double-counts back-to-back
    chats — that IS the lazy-streak signal.
    """
    now = datetime.utcnow()
    todo.mention_count = (todo.mention_count or 1) + 1
    todo.last_mentioned_at = now
    try:
        history = json.loads(todo.mention_history) if todo.mention_history else []
    except Exception:
        history = []
    history.append(now.isoformat())
    todo.mention_history = json.dumps(history)


VALID_STATES = ("not_yet", "doing", "done")

# Soft-delete window. Anything past this gets hard-purged by the lifespan
# sweeper. Tunable if Daniel wants longer/shorter undo runway.
SOFT_DELETE_TTL_HOURS = 24


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
    def get(self, db: Session, todo_id: int, include_deleted: bool = False) -> Todo | None:
        """Fetch a todo by id. Soft-deleted rows hidden by default;
        pass `include_deleted=True` to fetch tombstones (used by
        undelete + audit paths)."""
        q = db.query(Todo).filter(Todo.id == todo_id)
        if not include_deleted:
            q = q.filter(Todo.deleted_at.is_(None))
        return q.first()

    def list_open(self, db: Session) -> list[Todo]:
        """All not-yet-done todos, sorted with `doing` floated above
        `not_yet` and tied within state by sort_order. Soft-deleted
        rows excluded."""
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
            .filter(Todo.done.is_(False), Todo.deleted_at.is_(None))
            .order_by(state_rank, Todo.sort_order, Todo.id)
            .all()
        )

    def list_done_today(self, db: Session) -> list[Todo]:
        """Todos completed today (used by the Done section's Completed
        view). 'Today' = local midnight in `Settings.nudge_tz`
        (defaults to America/Los_Angeles), converted to UTC for the
        comparison. Was UTC midnight, which leaked yesterday-evening-
        PST completions into 'today'.
        """
        settings = db.query(Settings).first()
        tz_name = (settings.nudge_tz if settings else None) or "America/Los_Angeles"
        try:
            tz = ZoneInfo(tz_name)
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("UTC")
        now_local = datetime.now(tz)
        local_midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        # `completed_at` is stored as naive UTC, so strip tzinfo after
        # converting to UTC to keep the comparison apples-to-apples.
        cutoff_utc = local_midnight.astimezone(timezone.utc).replace(tzinfo=None)
        return (
            db.query(Todo)
            .filter(
                Todo.done.is_(True),
                Todo.completed_at.is_not(None),
                Todo.completed_at >= cutoff_utc,
                Todo.deleted_at.is_(None),
            )
            .order_by(Todo.completed_at.desc())
            .all()
        )

    def get_primary(self, db: Session) -> Todo | None:
        return (
            db.query(Todo)
            .filter(
                Todo.is_primary.is_(True),
                Todo.done.is_(False),
                Todo.deleted_at.is_(None),
            )
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

        # G3 mention dedup: if Daniel utters something that cosine-matches
        # an existing OPEN todo at ≥0.85, bump that row's counter instead
        # of inserting a duplicate. Skips re-creating todos he's already
        # been ignoring; preserves the recurrence signal.
        if embed_vec and state != "done":
            existing, _score = _find_open_todo_for_mention(db, embed_vec)
            if existing is not None:
                _bump_mention(db, existing)
                db.commit()
                db.refresh(existing)
                return existing

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

        # G3 focus binding: wire `supports` edge to nearest matching active
        # focus if the new todo clears the cross-kind cosine floor. Failure
        # never blocks the create path — graph wiring is a side effect.
        if embed_vec:
            try:
                fid = focus_binding.bind_to_focus(
                    db, src_kind="todo", src_id=t.id, embedding=embed_vec
                )
                # If no explicit focus_id was set + we found a graph match,
                # mirror it onto the FK so existing focus-bucket queries work
                # without re-traversing edges. Only on auto-bind, never override.
                if fid is not None and t.focus_id is None:
                    t.focus_id = fid
                    db.commit()
            except Exception as e:
                print(f"[todo_service] focus bind failed: {e}")

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
            prev_state = t.state
            t.state = new_state
            t.done = _state_to_done(new_state)
            t.completed_at = datetime.utcnow() if new_state == "done" else None
            if new_state == "done":
                t.is_primary = False
            # PR-6 procrastination clock: stamp on entry to 'doing', clear
            # on exit so a stale-doing nudge measures the current sit.
            if new_state == "doing" and prev_state != "doing":
                t.doing_started_at = datetime.utcnow()
                t.last_nudge_sent_at = None
            elif new_state != "doing":
                t.doing_started_at = None
        elif "done" in patch:
            new_done = bool(patch["done"])
            t.done = new_done
            t.state = "done" if new_done else "not_yet"
            t.completed_at = datetime.utcnow() if new_done else None
            if new_done:
                t.is_primary = False
                t.doing_started_at = None

        for key in ("text", "subtitle", "due_date", "sort_order", "focus_id", "is_primary", "closure_note"):
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
        """Soft-delete: stamp deleted_at, leave row in place for 24h
        undo. Hard-purge happens via sweeper. Clears is_primary so the
        slot opens immediately. Linked backlog tickets keep the FK —
        they get cleared at purge time (not at soft-delete time) so
        undelete can re-attach.
        """
        t = self.get(db, todo_id)
        if not t:
            return False
        t.deleted_at = datetime.utcnow()
        # Free the primary slot immediately — Daniel shouldn't see the
        # soft-deleted row holding the slot during the undo window.
        if t.is_primary:
            t.is_primary = False
        db.commit()
        return True

    def undelete(self, db: Session, todo_id: int) -> Todo | None:
        """Reverse a soft-delete within the 24h window. Returns the
        restored Todo or None if (a) row doesn't exist, (b) row wasn't
        soft-deleted, or (c) the undo window has expired.
        """
        t = self.get(db, todo_id, include_deleted=True)
        if not t or t.deleted_at is None:
            return None
        if datetime.utcnow() - t.deleted_at > timedelta(hours=SOFT_DELETE_TTL_HOURS):
            return None
        t.deleted_at = None
        db.commit()
        db.refresh(t)
        return t

    def list_recently_deleted(
        self, db: Session, since: datetime | None = None
    ) -> list[Todo]:
        """Tombstones still in the undo window, newest first. `since`
        narrows further (e.g., for conv-scoped 'undo last op').
        """
        cutoff = datetime.utcnow() - timedelta(hours=SOFT_DELETE_TTL_HOURS)
        if since is not None and since > cutoff:
            cutoff = since
        return (
            db.query(Todo)
            .filter(Todo.deleted_at.isnot(None), Todo.deleted_at >= cutoff)
            .order_by(Todo.deleted_at.desc())
            .all()
        )

    def purge_old_deleted(self, db: Session) -> int:
        """Hard-delete tombstones past the 24h window. Returns count
        purged. Called by the lifespan sweeper. Linked backlog tickets
        get their todo_id cleared here (not at soft-delete time) so
        undelete during the window can re-attach.
        """
        from ..db.models import BacklogTicket
        cutoff = datetime.utcnow() - timedelta(hours=SOFT_DELETE_TTL_HOURS)
        stale = (
            db.query(Todo)
            .filter(Todo.deleted_at.isnot(None), Todo.deleted_at < cutoff)
            .all()
        )
        if not stale:
            return 0
        ids = [t.id for t in stale]
        db.query(BacklogTicket).filter(BacklogTicket.todo_id.in_(ids)).update(
            {"todo_id": None}, synchronize_session=False
        )
        for t in stale:
            db.delete(t)
        db.commit()
        return len(stale)

    def bulk_soft_delete(self, db: Session, ids: list[int]) -> list[int]:
        """Soft-delete N todos in one go. Returns the ids actually
        deleted (skips already-deleted or missing rows)."""
        if not ids:
            return []
        now = datetime.utcnow()
        rows = (
            db.query(Todo)
            .filter(Todo.id.in_(ids), Todo.deleted_at.is_(None))
            .all()
        )
        deleted: list[int] = []
        for t in rows:
            t.deleted_at = now
            if t.is_primary:
                t.is_primary = False
            deleted.append(t.id)
        if deleted:
            db.commit()
        return deleted

    def merge(
        self, db: Session, primary_id: int, merged_ids: list[int]
    ) -> Todo | None:
        """Soft-merge: concat merged todos' text into primary.subtitle
        (newline-joined), then soft-delete the merged rows. Primary's
        text stays as-is. Returns the updated primary, or None if
        primary doesn't exist.
        """
        primary = self.get(db, primary_id)
        if primary is None:
            return None
        merged_ids = [m for m in (merged_ids or []) if m and m != primary_id]
        if not merged_ids:
            return primary
        merged_rows = (
            db.query(Todo)
            .filter(Todo.id.in_(merged_ids), Todo.deleted_at.is_(None))
            .all()
        )
        if not merged_rows:
            return primary
        # Append merged text strings to subtitle. Keep idempotent — if
        # we re-run with the same merge set, we don't keep stacking.
        appended = "\n".join(f"+ {r.text}" for r in merged_rows)
        if primary.subtitle:
            primary.subtitle = f"{primary.subtitle}\n{appended}"
        else:
            primary.subtitle = appended
        now = datetime.utcnow()
        for r in merged_rows:
            r.deleted_at = now
            if r.is_primary:
                r.is_primary = False
        db.commit()
        db.refresh(primary)
        return primary

    # ── G3.5 Todo Continuity — closure capture + lineage edges ──────
    #
    # Closure ≠ end-of-thread. When a todo closes, the work often continues
    # (outcomes happen, follow-ups emerge). These methods let callers
    # capture a `closure_note` on the parent + spawn child todos with
    # `spawned_from` edges so the lineage graph stays walkable.
    #
    # `spawned_from` is M:N — a closed todo can spawn multiple follow-ups;
    # a follow-up can have multiple ancestors when a merge happens. Edges
    # live in the generic `edges` table (kind='spawned_from', src=child,
    # dst=parent — convention is "src has property X dst").

    def close_with_outcome(
        self,
        db: Session,
        todo_id: int,
        *,
        closure_note: str | None = None,
        spawned: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Close a todo with optional outcome text + optional spawned
        follow-ups. Single transaction.

        Args:
          todo_id: the todo being closed
          closure_note: optional short outcome text (TEXT col on Todo)
          spawned: list of {text, due_hint?, subtitle?} dicts. Each becomes
            a new Todo with a `spawned_from` edge pointing back to todo_id.
            Inherits focus_id from the parent so chains stay focused.

        Returns:
          {
            "parent": serialized Todo,
            "spawned": [serialized Todo, ...],
            "edges": [edge_id, ...],
          }
          Or None if todo_id doesn't exist.
        """
        from . import edge_service

        parent = self.get(db, todo_id)
        if parent is None:
            return None

        # Close the parent. Reuses update() so backlog-ticket auto-sync
        # + is_primary auto-clear behavior stays intact.
        if (closure_note or "").strip():
            parent.closure_note = closure_note.strip()
        self.update(db, todo_id, state="done")
        db.refresh(parent)

        # Spawn children. Each inherits parent's focus_id so threads stay
        # within the same focus context.
        spawned_rows: list[Todo] = []
        edge_ids: list[int] = []
        for spec in (spawned or []):
            text = (spec.get("text") or "").strip()
            if not text:
                continue
            due_at = spec.get("due_date")
            if due_at is None:
                from ..services.intent_handlers.todos import _parse_due
                due_at = _parse_due(spec.get("due_hint"))
            child = self.create(
                db,
                text=text,
                subtitle=spec.get("subtitle"),
                due_date=due_at,
                focus_id=parent.focus_id,
            )
            edge = edge_service.link(
                db,
                src_kind="todo",
                src_id=child.id,
                dst_kind="todo",
                dst_id=parent.id,
                kind="spawned_from",
            )
            spawned_rows.append(child)
            if edge is not None:
                edge_ids.append(edge.id)

        return {
            "parent": serialize_todo(parent),
            "spawned": [serialize_todo(t) for t in spawned_rows],
            "edges": edge_ids,
        }

    def add_parent(
        self, db: Session, child_id: int, parent_id: int
    ) -> bool:
        """Wire a `spawned_from` edge from child → parent. Idempotent.
        Returns True if either created or already existed; False if
        either todo is missing or child == parent."""
        from . import edge_service

        if child_id == parent_id:
            return False
        child = self.get(db, child_id)
        parent = self.get(db, parent_id)
        if child is None or parent is None:
            return False
        edge_service.link(
            db,
            src_kind="todo",
            src_id=child_id,
            dst_kind="todo",
            dst_id=parent_id,
            kind="spawned_from",
        )
        return True

    def remove_parent(
        self, db: Session, child_id: int, parent_id: int
    ) -> int:
        """Drop the `spawned_from` edge between child and parent.
        Returns count deleted (0 or 1)."""
        from . import edge_service

        return edge_service.unlink(
            db,
            src_kind="todo",
            src_id=child_id,
            dst_kind="todo",
            dst_id=parent_id,
            kind="spawned_from",
        )

    def bulk_chain_summary(
        self, db: Session, todo_ids: list[int] | None = None
    ) -> dict[int, dict]:
        """Build the per-todo chain_summary map used by the /todos
        endpoint AND the show_my_plate chat tool AND state_block chain
        inline rendering (G3.9). When todo_ids is None, covers every
        open todo (the dashboard view); otherwise only those ids.

        Returns: {tid: {"children_total", "children_done", "parent_id",
                        "parent_text"}}
        Todos with no parent and no children are absent from the map
        (caller treats missing == orphan).
        """
        from ..db.models import Edge, Todo as _TodoModel

        if todo_ids is None:
            open_rows = self.list_open(db)
            relevant_ids = {t.id for t in open_rows}
        else:
            relevant_ids = set(todo_ids)
        if not relevant_ids:
            return {}

        out: dict[int, dict] = {}
        try:
            edge_rows = (
                db.query(Edge)
                .filter(Edge.kind == "spawned_from")
                .filter(Edge.src_kind == "todo", Edge.dst_kind == "todo")
                .all()
            )
            child_to_parent: dict[int, int] = {}
            parent_to_children: dict[int, list[int]] = {}
            for e in edge_rows:
                child_to_parent[e.src_id] = e.dst_id
                parent_to_children.setdefault(e.dst_id, []).append(e.src_id)

            extra_ids: set[int] = set()
            for cid, pid in child_to_parent.items():
                if cid in relevant_ids:
                    extra_ids.add(pid)
            for pid, cids in parent_to_children.items():
                if pid in relevant_ids:
                    extra_ids |= set(cids)
            all_ids = relevant_ids | extra_ids
            if all_ids:
                todo_lookup = {
                    t.id: t
                    for t in db.query(_TodoModel)
                    .filter(_TodoModel.id.in_(all_ids))
                    .all()
                }
            else:
                todo_lookup = {}

            for tid in relevant_ids:
                children = parent_to_children.get(tid, [])
                child_total = len(children)
                child_done = sum(
                    1
                    for cid in children
                    if (todo_lookup.get(cid) and todo_lookup[cid].done)
                )
                parent_id = child_to_parent.get(tid)
                parent_text = (
                    (todo_lookup.get(parent_id).text or "").strip()
                    if parent_id and todo_lookup.get(parent_id)
                    else None
                )
                if child_total > 0 or parent_id is not None:
                    out[tid] = {
                        "children_total": child_total,
                        "children_done": child_done,
                        "parent_id": parent_id,
                        "parent_text": parent_text,
                    }
        except Exception as e:
            print(f"[todo_service.bulk_chain_summary] {e}")
            return {}
        return out

    def get_chain(
        self,
        db: Session,
        todo_id: int,
        *,
        max_depth: int = 10,
    ) -> dict[str, Any] | None:
        """Walk the lineage graph centered on todo_id. Returns a dict
        with three lists:
          {
            "this":        serialized Todo,
            "ancestors":   [{todo: serialized, depth: int}, ...],  # parents, grandparents, ...
            "descendants": [{todo: serialized, depth: int}, ...],  # children, grandchildren, ...
          }

        BFS in each direction up to max_depth. Returns None if the todo
        doesn't exist. Soft-deleted nodes ARE included (chain history is
        valuable even when a node was killed) — caller decides whether
        to render them.
        """
        from . import edge_service

        this = self.get(db, todo_id, include_deleted=True)
        if this is None:
            return None

        def walk(start_id: int, direction: str) -> list[dict[str, Any]]:
            """direction='up' = ancestors (follow src.spawned_from→dst);
            direction='down' = descendants (follow dst.spawned_from→src)."""
            out: list[dict[str, Any]] = []
            seen: set[int] = {start_id}
            frontier: list[tuple[int, int]] = [(start_id, 0)]  # (id, depth)
            while frontier:
                next_frontier: list[tuple[int, int]] = []
                for nid, depth in frontier:
                    if depth >= max_depth:
                        continue
                    neighbors = edge_service.neighbors(
                        db,
                        kind_of_node="todo",
                        node_id=nid,
                        edge_kind="spawned_from",
                        direction="out" if direction == "up" else "in",
                    )
                    for nb_kind, nb_id, _ek in neighbors:
                        if nb_kind != "todo" or nb_id in seen:
                            continue
                        seen.add(nb_id)
                        nb_todo = self.get(db, nb_id, include_deleted=True)
                        if nb_todo is None:
                            continue
                        out.append(
                            {
                                "todo": serialize_todo(nb_todo),
                                "depth": depth + 1,
                            }
                        )
                        next_frontier.append((nb_id, depth + 1))
                frontier = next_frontier
            return out

        return {
            "this": serialize_todo(this),
            "ancestors": walk(todo_id, "up"),
            "descendants": walk(todo_id, "down"),
        }

    def search(
        self,
        db: Session,
        query: str,
        *,
        limit: int = 10,
        include_done: bool = True,
    ) -> list[Todo]:
        """Fuzzy search for retroactive-linking UI.

        Two-pass: FTS5 first (BM25-ranked, O(log N) via todos_fts virtual
        table), then a substring LIKE fallback to catch matches FTS missed
        — partial-word fragments ("groc" → "groceries"), since FTS tokenizes
        on word boundaries. Both passes filter soft-deleted rows.

        Returns up to `limit` rows. FTS hits float first; substring-only
        hits fill remaining slots.
        """
        raw = (query or "").strip()
        if not raw:
            return []

        # ── FTS5 pass ────────────────────────────────────────────────
        fts_cleaned = _FTS_TODO_STRIP.sub(" ", raw).strip()
        fts_ids: list[int] = []
        if fts_cleaned:
            try:
                rows = db.execute(
                    sa_text(
                        "SELECT rowid FROM todos_fts "
                        "WHERE todos_fts MATCH :q "
                        "ORDER BY rank LIMIT :lim"
                    ),
                    {"q": fts_cleaned, "lim": limit * 2},
                ).fetchall()
                fts_ids = [r[0] for r in rows]
            except Exception as e:
                print(f"[todo_service] FTS search failed (ignored): {e}")

        # ── Substring LIKE fallback ──────────────────────────────────
        # Cheap, catches partial-word hits FTS misses. Limited to active
        # todos + recent done ones via the existing recency sort downstream.
        like = f"%{raw.lower()}%"
        like_rows: list[Todo] = (
            db.query(Todo)
            .filter(Todo.deleted_at.is_(None))
            .filter(sa_text("LOWER(text) LIKE :p OR LOWER(COALESCE(subtitle, '')) LIKE :p"))
            .params(p=like)
            .all()
        )
        like_ids = [t.id for t in like_rows]

        # Merge: FTS-ranked first, LIKE-only matches fill remaining slots.
        seen: set[int] = set()
        merged_ids: list[int] = []
        for tid in fts_ids:
            if tid not in seen:
                seen.add(tid)
                merged_ids.append(tid)
        for tid in like_ids:
            if tid not in seen:
                seen.add(tid)
                merged_ids.append(tid)
        if not merged_ids:
            return []

        # Load full rows, filter done if requested, apply legacy score
        # ordering (shorter text + non-done first) for ties WITHIN each
        # source — FTS already ranks, LIKE doesn't.
        full = (
            db.query(Todo)
            .filter(Todo.id.in_(merged_ids), Todo.deleted_at.is_(None))
            .all()
        )
        by_id = {t.id: t for t in full}
        out: list[Todo] = []
        for tid in merged_ids:
            t = by_id.get(tid)
            if t is None:
                continue
            if not include_done and t.done:
                continue
            out.append(t)
            if len(out) >= limit:
                break
        return out

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
                Todo.deleted_at.is_(None),
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
        "closure_note": t.closure_note,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


todo_service = TodoService()
