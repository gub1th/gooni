"""dashboard revamp — todo state enum + focus_id/is_primary, focus.color,
   backlog_tickets.todo_id, drop focus_todo_links

Schema additions:
  todos.state          (enum: not_yet | doing | done; default 'not_yet';
                        backfilled from existing `done` boolean)
  todos.focus_id       (nullable FK → focuses.id; backfilled from
                        focus_todo_links — pick the lowest-id link per todo
                        if multiple, then drop the M2M table)
  todos.is_primary     (boolean, default false; singleton — service enforces)
  focuses.color        (string hex; backfilled by cycling a 10-color palette)
  backlog_tickets.todo_id (nullable FK → todos.id)
  backlog_tickets.board_status remap: 'todo' → 'not_yet',
                                      'in_progress' → 'doing',
                                      'done' → 'done'

Schema deletions:
  focuses.is_primary       (primary moved to Todo)
  focus_todo_links table   (replaced by single todos.focus_id FK)

Destructive: down=raise. Take a DB backup before deploying.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e6c2a9b1f4d3"
down_revision: Union[str, Sequence[str], None] = "bd8adf4caf86"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 10-color accessible palette for focus dots. focus_service mirrors this
# so newly-created focuses cycle through the same set; the migration
# uses it once to seed existing rows.
_PALETTE = [
    "#22C55E",  # green
    "#3B82F6",  # blue
    "#F59E0B",  # amber
    "#A855F7",  # violet
    "#EF4444",  # red
    "#06B6D4",  # cyan
    "#EC4899",  # pink
    "#84CC16",  # lime
    "#F97316",  # orange
    "#14B8A6",  # teal
]


def _has_column(bind, table: str, column: str) -> bool:
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def _has_table(bind, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": name},
        ).first()
    )


def upgrade() -> None:
    bind = op.get_bind()

    # ── todos.state ────────────────────────────────────────────────────
    if not _has_column(bind, "todos", "state"):
        with op.batch_alter_table("todos") as batch_op:
            batch_op.add_column(sa.Column("state", sa.String(), nullable=True))
        bind.execute(sa.text(
            "UPDATE todos SET state = CASE WHEN done = 1 THEN 'done' ELSE 'not_yet' END"
        ))
        with op.batch_alter_table("todos") as batch_op:
            batch_op.alter_column("state", nullable=False, server_default="not_yet")
            batch_op.create_index("ix_todos_state", ["state"])

    # ── todos.focus_id (backfilled from focus_todo_links, then drop M2M) ─
    if not _has_column(bind, "todos", "focus_id"):
        with op.batch_alter_table("todos") as batch_op:
            batch_op.add_column(sa.Column("focus_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                "fk_todos_focus_id", "focuses", ["focus_id"], ["id"]
            )
            batch_op.create_index("ix_todos_focus_id", ["focus_id"])
        if _has_table(bind, "focus_todo_links"):
            # Pick lowest-id link per todo. If a todo had multiple focuses,
            # we keep the first link's focus and drop the rest.
            bind.execute(sa.text(
                "UPDATE todos SET focus_id = ("
                "  SELECT focus_id FROM focus_todo_links "
                "  WHERE focus_todo_links.todo_id = todos.id "
                "  ORDER BY focus_todo_links.id ASC LIMIT 1"
                ")"
            ))

    # ── todos.is_primary ────────────────────────────────────────────────
    if not _has_column(bind, "todos", "is_primary"):
        with op.batch_alter_table("todos") as batch_op:
            batch_op.add_column(
                sa.Column(
                    "is_primary",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.text("0"),
                )
            )

    # ── focuses.color (cycle palette over existing rows) ───────────────
    if not _has_column(bind, "focuses", "color"):
        with op.batch_alter_table("focuses") as batch_op:
            batch_op.add_column(sa.Column("color", sa.String(), nullable=True))
        focus_ids = [
            r[0] for r in bind.execute(
                sa.text("SELECT id FROM focuses ORDER BY id ASC")
            ).fetchall()
        ]
        for idx, fid in enumerate(focus_ids):
            color = _PALETTE[idx % len(_PALETTE)]
            bind.execute(
                sa.text("UPDATE focuses SET color = :c WHERE id = :id"),
                {"c": color, "id": fid},
            )

    # ── focuses.is_primary drop (primary lives on Todo now) ────────────
    if _has_column(bind, "focuses", "is_primary"):
        with op.batch_alter_table("focuses") as batch_op:
            batch_op.drop_column("is_primary")

    # ── backlog_tickets.todo_id ─────────────────────────────────────────
    if not _has_column(bind, "backlog_tickets", "todo_id"):
        with op.batch_alter_table("backlog_tickets") as batch_op:
            batch_op.add_column(sa.Column("todo_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                "fk_backlog_tickets_todo_id", "todos", ["todo_id"], ["id"]
            )
            batch_op.create_index("ix_backlog_tickets_todo_id", ["todo_id"])

    # ── backlog_tickets.board_status remap ──────────────────────────────
    bind.execute(sa.text(
        "UPDATE backlog_tickets SET board_status = 'not_yet' WHERE board_status = 'todo'"
    ))
    bind.execute(sa.text(
        "UPDATE backlog_tickets SET board_status = 'doing' WHERE board_status = 'in_progress'"
    ))

    # ── focus_todo_links table drop ─────────────────────────────────────
    if _has_table(bind, "focus_todo_links"):
        op.drop_table("focus_todo_links")


def downgrade() -> None:
    raise RuntimeError(
        "Destructive migration. Restore from db/gooni.db.bak.{ts} and revert "
        "the deploy instead."
    )
