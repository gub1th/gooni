"""extract focuses + todos + backlog_tickets out of list_items

Splits the god-table `list_items` into 3 dedicated tables:

  - focuses          (the long-running commitment fields: endgoal, health,
                      confidence, scale, is_primary, status, start_at,
                      end_at, committed)
  - todos            (the actionable-item fields: due_date)
  - backlog_tickets  (the Jira-board fields: board_status, pr_url)

After backfill, list_items keeps only its generic shape (text, subtitle,
done, sort_order, embedding) so user-defined lists (shopping etc.) still
work.

Destructive: the migrated rows are deleted out of list_items. Rollback is
explicitly NOT supported via downgrade() — restore from
db/gooni.db.bak.{ts} instead.

Migration steps:

  1. Create the three new tables.
  2. Backfill focuses from list_items where list.type='focus' and
     parent_id IS NULL. Build old_to_new id map.
  3. Backfill todos. Two sources:
     a. Leaves in list.type='todo' lists.
     b. Children under focus list_items (parent_id NOT NULL) — they
        become todos linked to the parent focus via focus_todo_links.
        Multi-level nesting is flattened; the legacy schema didn't
        actually use it.
  4. Backfill backlog_tickets from list.type='backlog' list_items.
  5. Rebuild focus_todo_links: rename focus_item_id -> focus_id (FK to
     focuses.id) and todo_item_id -> todo_id (FK to todos.id), updating
     row values via the id maps from steps 2 + 3.
  6. Repoint memories.focus_id from list_items.id -> focuses.id.
  7. Delete migrated rows out of list_items + drop the now-unused columns
     (endgoal, committed, is_primary, status, scale, health, confidence,
     start_at, end_at, due_date, board_status, pr_url).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e1f2a3b5c8"
down_revision: Union[str, Sequence[str], None] = "c7e8d2f4a1b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Columns being dropped from list_items after backfill. SQLite supports
# ALTER TABLE DROP COLUMN since 3.35; op.batch_alter_table handles older
# engines via the table-rebuild dance.
_DROPPED_LIST_ITEM_COLUMNS = [
    "endgoal",
    "committed",
    "is_primary",
    "status",
    "scale",
    "health",
    "confidence",
    "start_at",
    "end_at",
    "due_date",
    "board_status",
    "pr_url",
    "parent_id",  # subtree nesting collapses into focus_todo_links
]


def _has_table(bind, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": name},
        ).first()
    )


def _has_column(bind, table: str, column: str) -> bool:
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def upgrade() -> None:
    bind = op.get_bind()

    # ── 1. Create the three new tables ─────────────────────────────────
    if not _has_table(bind, "focuses"):
        op.create_table(
            "focuses",
            sa.Column("id", sa.Integer(), primary_key=True, index=True),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("subtitle", sa.Text(), nullable=True),
            sa.Column("endgoal", sa.Text(), nullable=True),
            sa.Column("committed", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("status", sa.String(), nullable=True),
            sa.Column("scale", sa.String(), nullable=True),
            sa.Column("health", sa.Integer(), nullable=True),
            sa.Column("confidence", sa.Integer(), nullable=True),
            sa.Column("start_at", sa.DateTime(), nullable=True),
            sa.Column("end_at", sa.DateTime(), nullable=True),
            sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("source_note_id", sa.Integer(), sa.ForeignKey("notes.id"), nullable=True),
            sa.Column("embedding", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )

    if not _has_table(bind, "todos"):
        op.create_table(
            "todos",
            sa.Column("id", sa.Integer(), primary_key=True, index=True),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("subtitle", sa.Text(), nullable=True),
            sa.Column("due_date", sa.DateTime(), nullable=True, index=True),
            sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("source_note_id", sa.Integer(), sa.ForeignKey("notes.id"), nullable=True),
            sa.Column("embedding", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )

    if not _has_table(bind, "backlog_tickets"):
        op.create_table(
            "backlog_tickets",
            sa.Column("id", sa.Integer(), primary_key=True, index=True),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("subtitle", sa.Text(), nullable=True),
            sa.Column("board_status", sa.String(), nullable=True),
            sa.Column("pr_url", sa.Text(), nullable=True),
            sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("source_note_id", sa.Integer(), sa.ForeignKey("notes.id"), nullable=True),
            sa.Column("embedding", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )

    # ── 2. Backfill focuses ───────────────────────────────────────────
    # Top-level rows in lists of type='focus'. Each old list_items.id
    # maps to a new focuses.id; we keep that map in memory for steps 3+5+6.
    focus_id_map: dict[int, int] = {}
    focus_lists = bind.execute(
        sa.text("SELECT id FROM lists WHERE type='focus'")
    ).fetchall()
    focus_list_ids = [r[0] for r in focus_lists]

    if focus_list_ids:
        placeholders = ",".join(str(i) for i in focus_list_ids)
        focus_rows = bind.execute(
            sa.text(
                f"SELECT id, text, subtitle, endgoal, committed, is_primary, "
                f"status, scale, health, confidence, start_at, end_at, done, "
                f"completed_at, sort_order, source_note_id, embedding, "
                f"created_at, updated_at "
                f"FROM list_items "
                f"WHERE list_id IN ({placeholders}) AND parent_id IS NULL"
            )
        ).fetchall()

        for r in focus_rows:
            res = bind.execute(
                sa.text(
                    "INSERT INTO focuses (text, subtitle, endgoal, committed, "
                    "is_primary, status, scale, health, confidence, start_at, "
                    "end_at, done, completed_at, sort_order, source_note_id, "
                    "embedding, created_at, updated_at) VALUES "
                    "(:text, :subtitle, :endgoal, :committed, :is_primary, "
                    ":status, :scale, :health, :confidence, :start_at, :end_at, "
                    ":done, :completed_at, :sort_order, :source_note_id, "
                    ":embedding, :created_at, :updated_at)"
                ),
                {
                    "text": r[1], "subtitle": r[2], "endgoal": r[3],
                    "committed": r[4] or False, "is_primary": r[5] or False,
                    "status": r[6], "scale": r[7], "health": r[8],
                    "confidence": r[9], "start_at": r[10], "end_at": r[11],
                    "done": r[12] or False, "completed_at": r[13],
                    "sort_order": r[14] or 0, "source_note_id": r[15],
                    "embedding": r[16], "created_at": r[17], "updated_at": r[18],
                },
            )
            focus_id_map[r[0]] = res.lastrowid

    # ── 3. Backfill todos ─────────────────────────────────────────────
    # Two sources:
    #   (a) leaves in lists of type='todo'
    #   (b) children of focus list_items (parent_id NOT NULL inside a focus list)
    todo_id_map: dict[int, int] = {}
    # Track which old list_item ids became todos that descend from a focus,
    # so we can rebuild focus_todo_links rows for them.
    descendant_focus_links: list[tuple[int, int]] = []  # (focus_id new, todo_id new)

    todo_lists = bind.execute(
        sa.text("SELECT id FROM lists WHERE type='todo'")
    ).fetchall()
    todo_list_ids = [r[0] for r in todo_lists]

    if todo_list_ids:
        placeholders = ",".join(str(i) for i in todo_list_ids)
        todo_rows = bind.execute(
            sa.text(
                f"SELECT id, text, subtitle, due_date, done, completed_at, "
                f"sort_order, source_note_id, embedding, created_at, updated_at "
                f"FROM list_items "
                f"WHERE list_id IN ({placeholders})"
            )
        ).fetchall()
        for r in todo_rows:
            res = bind.execute(
                sa.text(
                    "INSERT INTO todos (text, subtitle, due_date, done, "
                    "completed_at, sort_order, source_note_id, embedding, "
                    "created_at, updated_at) VALUES "
                    "(:text, :subtitle, :due_date, :done, :completed_at, "
                    ":sort_order, :source_note_id, :embedding, :created_at, "
                    ":updated_at)"
                ),
                {
                    "text": r[1], "subtitle": r[2], "due_date": r[3],
                    "done": r[4] or False, "completed_at": r[5],
                    "sort_order": r[6] or 0, "source_note_id": r[7],
                    "embedding": r[8], "created_at": r[9], "updated_at": r[10],
                },
            )
            todo_id_map[r[0]] = res.lastrowid

    # Children of focuses → todos linked to the parent focus.
    if focus_list_ids:
        placeholders = ",".join(str(i) for i in focus_list_ids)
        child_rows = bind.execute(
            sa.text(
                f"SELECT id, parent_id, text, subtitle, due_date, done, "
                f"completed_at, sort_order, source_note_id, embedding, "
                f"created_at, updated_at "
                f"FROM list_items "
                f"WHERE list_id IN ({placeholders}) AND parent_id IS NOT NULL"
            )
        ).fetchall()

        # Walk to collapse multi-level nesting: every descendant maps to
        # its top-level focus ancestor.
        # Build parent_id lookup over focus-list rows.
        parent_lookup = {r[0]: r[1] for r in child_rows}
        # Top-level focus ids (already migrated).
        top_focus_ids = set(focus_id_map.keys())

        def top_ancestor(item_id: int) -> int | None:
            cursor = item_id
            while cursor in parent_lookup:
                cursor = parent_lookup[cursor]
            return cursor if cursor in top_focus_ids else None

        for r in child_rows:
            top_old = top_ancestor(r[0])
            if top_old is None:
                continue  # orphaned child — drop on the floor
            res = bind.execute(
                sa.text(
                    "INSERT INTO todos (text, subtitle, due_date, done, "
                    "completed_at, sort_order, source_note_id, embedding, "
                    "created_at, updated_at) VALUES "
                    "(:text, :subtitle, :due_date, :done, :completed_at, "
                    ":sort_order, :source_note_id, :embedding, :created_at, "
                    ":updated_at)"
                ),
                {
                    "text": r[2], "subtitle": r[3], "due_date": r[4],
                    "done": r[5] or False, "completed_at": r[6],
                    "sort_order": r[7] or 0, "source_note_id": r[8],
                    "embedding": r[9], "created_at": r[10], "updated_at": r[11],
                },
            )
            new_todo_id = res.lastrowid
            todo_id_map[r[0]] = new_todo_id
            descendant_focus_links.append((focus_id_map[top_old], new_todo_id))

    # ── 4. Backfill backlog_tickets ───────────────────────────────────
    backlog_lists = bind.execute(
        sa.text("SELECT id FROM lists WHERE type='backlog'")
    ).fetchall()
    backlog_list_ids = [r[0] for r in backlog_lists]
    backlog_id_map: dict[int, int] = {}

    if backlog_list_ids:
        placeholders = ",".join(str(i) for i in backlog_list_ids)
        backlog_rows = bind.execute(
            sa.text(
                f"SELECT id, text, subtitle, board_status, pr_url, done, "
                f"completed_at, sort_order, source_note_id, embedding, "
                f"created_at, updated_at "
                f"FROM list_items "
                f"WHERE list_id IN ({placeholders})"
            )
        ).fetchall()
        for r in backlog_rows:
            res = bind.execute(
                sa.text(
                    "INSERT INTO backlog_tickets (text, subtitle, board_status, "
                    "pr_url, done, completed_at, sort_order, source_note_id, "
                    "embedding, created_at, updated_at) VALUES "
                    "(:text, :subtitle, :board_status, :pr_url, :done, "
                    ":completed_at, :sort_order, :source_note_id, :embedding, "
                    ":created_at, :updated_at)"
                ),
                {
                    "text": r[1], "subtitle": r[2], "board_status": r[3],
                    "pr_url": r[4], "done": r[5] or False, "completed_at": r[6],
                    "sort_order": r[7] or 0, "source_note_id": r[8],
                    "embedding": r[9], "created_at": r[10], "updated_at": r[11],
                },
            )
            backlog_id_map[r[0]] = res.lastrowid

    # ── 5. Rebuild focus_todo_links with new FKs ──────────────────────
    # Old shape: focus_item_id + todo_item_id → list_items.id
    # New shape: focus_id + todo_id → focuses.id + todos.id
    if _has_table(bind, "focus_todo_links"):
        old_links = bind.execute(
            sa.text(
                "SELECT focus_item_id, todo_item_id, created_at "
                "FROM focus_todo_links"
            )
        ).fetchall()
        op.drop_table("focus_todo_links")
    else:
        old_links = []

    op.create_table(
        "focus_todo_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("focus_id", sa.Integer(), sa.ForeignKey("focuses.id"), nullable=False, index=True),
        sa.Column("todo_id", sa.Integer(), sa.ForeignKey("todos.id"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("focus_id", "todo_id", name="uq_focus_todo_link"),
    )

    # Replay old explicit links.
    for old_focus_item_id, old_todo_item_id, created_at in old_links:
        new_focus_id = focus_id_map.get(old_focus_item_id)
        new_todo_id = todo_id_map.get(old_todo_item_id)
        if new_focus_id is None or new_todo_id is None:
            continue
        bind.execute(
            sa.text(
                "INSERT OR IGNORE INTO focus_todo_links "
                "(focus_id, todo_id, created_at) "
                "VALUES (:focus_id, :todo_id, :created_at)"
            ),
            {"focus_id": new_focus_id, "todo_id": new_todo_id, "created_at": created_at},
        )

    # Add focus->todo links for the descendant todos we created in step 3.
    for new_focus_id, new_todo_id in descendant_focus_links:
        bind.execute(
            sa.text(
                "INSERT OR IGNORE INTO focus_todo_links "
                "(focus_id, todo_id, created_at) "
                "VALUES (:focus_id, :todo_id, datetime('now'))"
            ),
            {"focus_id": new_focus_id, "todo_id": new_todo_id},
        )

    # ── 6. Repoint memories.focus_id → focuses.id ─────────────────────
    if _has_column(bind, "memories", "focus_id"):
        memory_rows = bind.execute(
            sa.text("SELECT id, focus_id FROM memories WHERE focus_id IS NOT NULL")
        ).fetchall()
        for memory_id, old_focus_id in memory_rows:
            new_focus_id = focus_id_map.get(old_focus_id)
            bind.execute(
                sa.text("UPDATE memories SET focus_id = :new_id WHERE id = :id"),
                {"new_id": new_focus_id, "id": memory_id},  # NULL if not found
            )

    # ── 7. Delete migrated rows + drop unused list_items columns ──────
    # Delete all rows that lived in focus / todo / backlog lists.
    drop_list_ids = focus_list_ids + todo_list_ids + backlog_list_ids
    if drop_list_ids:
        placeholders = ",".join(str(i) for i in drop_list_ids)
        bind.execute(
            sa.text(f"DELETE FROM list_items WHERE list_id IN ({placeholders})")
        )
        # Optionally delete the empty lists themselves so the sidebar no
        # longer shows phantom Focus/Todo/Backlog list rows.
        bind.execute(
            sa.text(f"DELETE FROM lists WHERE id IN ({placeholders})")
        )

    # Drop the now-unused columns from list_items. batch_alter_table handles
    # the SQLite table-rebuild dance for engines older than 3.35.
    #
    # Before opening the batch: drop ix_list_items_parent_id explicitly if
    # it exists. SQLite's batch rebuild copies the table to a temp, drops
    # the original, renames, and then re-CREATEs every index that lived on
    # the original. ix_list_items_parent_id references `parent_id` which
    # we're about to drop — recreating it crashes with
    # "no such column: parent_id". Telling the batch to drop_index ahead
    # of the column drop removes that index from the recreate set.
    inspector = sa.inspect(bind)
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("list_items")}
    with op.batch_alter_table("list_items") as batch_op:
        if "ix_list_items_parent_id" in existing_indexes:
            batch_op.drop_index(batch_op.f("ix_list_items_parent_id"))
        for col in _DROPPED_LIST_ITEM_COLUMNS:
            if _has_column(bind, "list_items", col):
                batch_op.drop_column(col)


def downgrade() -> None:
    raise RuntimeError(
        "Destructive migration. Restore from db/gooni.db.bak.{ts} and revert "
        "the deploy instead."
    )
