"""schema drift cleanup

Revision ID: e4fce556f864
Revises: 7e7a6d8e8c5d
Create Date: 2026-05-10 21:01:28.741959

Catches up prod schema with models.py after months of incremental drift
that prior feature migrations intentionally left out so their diffs
stayed reviewable. Items:

  - list_items.parent_id (+ index + FK) — added in models, never migrated
  - memories.retrieval_count NOT NULL + ix_memories_last_retrieved_at
  - memories.focus_id FK relink (list_items → focuses, post focus extract)
  - notes.is_draft INTEGER → Boolean + NOT NULL
  - notes.parent_note_id index + FK
  - settings.nudge_prompt NOT NULL
  - Drop server_defaults on focuses/todos/backlog_tickets (cosmetic — the
    Python-side defaults are the source of truth now)

Defensive: idempotent column/index adds (worktree-safe re-runs), and
NULL backfills before any NOT NULL alter so prod rows with legacy
NULLs survive the transition.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4fce556f864'
down_revision: Union[str, Sequence[str], None] = '7e7a6d8e8c5d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(inspector, table: str) -> set[str]:
    return {c['name'] for c in inspector.get_columns(table)}


def _indexes(inspector, table: str) -> set[str]:
    return {ix['name'] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ---- backlog_tickets: drop cosmetic server_defaults ----
    with op.batch_alter_table('backlog_tickets', schema=None) as batch_op:
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=None,
               existing_nullable=False)

    # ---- focuses: drop cosmetic server_defaults ----
    with op.batch_alter_table('focuses', schema=None) as batch_op:
        batch_op.alter_column('committed',
               existing_type=sa.BOOLEAN(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=None,
               existing_nullable=False)

    # ---- list_items.parent_id (idempotent) ----
    # FK ops intentionally omitted: SQLite doesn't enforce FKs unless
    # PRAGMA foreign_keys=ON, and alembic batch mode rejects anonymous
    # FK names. The ORM-side declarations in models.py drive query
    # relationships; the DB-level FK metadata is cosmetic. Same logic
    # applies to memories.focus_id relink and notes.parent_note_id below.
    li_cols = _columns(inspector, 'list_items')
    li_indexes = _indexes(inspector, 'list_items')
    with op.batch_alter_table('list_items', schema=None) as batch_op:
        if 'parent_id' not in li_cols:
            batch_op.add_column(sa.Column('parent_id', sa.Integer(), nullable=True))
        if 'ix_list_items_parent_id' not in li_indexes:
            batch_op.create_index(batch_op.f('ix_list_items_parent_id'), ['parent_id'], unique=False)

    # ---- memories: NOT NULL + index ----
    op.execute("UPDATE memories SET retrieval_count = 0 WHERE retrieval_count IS NULL")
    mem_indexes = _indexes(inspector, 'memories')
    with op.batch_alter_table('memories', schema=None) as batch_op:
        batch_op.alter_column('retrieval_count',
               existing_type=sa.INTEGER(),
               nullable=False)
        if 'ix_memories_last_retrieved_at' not in mem_indexes:
            batch_op.create_index(batch_op.f('ix_memories_last_retrieved_at'), ['last_retrieved_at'], unique=False)

    # ---- notes: is_draft NOT NULL + Boolean, parent_note_id index ----
    op.execute("UPDATE notes SET is_draft = 0 WHERE is_draft IS NULL")
    notes_indexes = _indexes(inspector, 'notes')
    with op.batch_alter_table('notes', schema=None) as batch_op:
        batch_op.alter_column('is_draft',
               existing_type=sa.INTEGER(),
               type_=sa.Boolean(),
               nullable=False)
        if 'ix_notes_parent_note_id' not in notes_indexes:
            batch_op.create_index(batch_op.f('ix_notes_parent_note_id'), ['parent_note_id'], unique=False)

    # ---- settings.nudge_prompt NOT NULL (empty string falls back to DEFAULT_PROMPT at read time) ----
    op.execute("UPDATE settings SET nudge_prompt = '' WHERE nudge_prompt IS NULL")
    with op.batch_alter_table('settings', schema=None) as batch_op:
        batch_op.alter_column('nudge_prompt',
               existing_type=sa.TEXT(),
               nullable=False)

    # ---- todos: drop cosmetic server_defaults ----
    with op.batch_alter_table('todos', schema=None) as batch_op:
        batch_op.alter_column('state',
               existing_type=sa.VARCHAR(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('is_primary',
               existing_type=sa.BOOLEAN(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=None,
               existing_nullable=False)
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=None,
               existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table('todos', schema=None) as batch_op:
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('is_primary',
               existing_type=sa.BOOLEAN(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('state',
               existing_type=sa.VARCHAR(),
               server_default=sa.text("'not_yet'"),
               existing_nullable=False)

    with op.batch_alter_table('settings', schema=None) as batch_op:
        batch_op.alter_column('nudge_prompt',
               existing_type=sa.TEXT(),
               nullable=True)

    with op.batch_alter_table('notes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_notes_parent_note_id'))
        batch_op.alter_column('is_draft',
               existing_type=sa.Boolean(),
               type_=sa.INTEGER(),
               nullable=True)

    with op.batch_alter_table('memories', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_memories_last_retrieved_at'))
        batch_op.alter_column('retrieval_count',
               existing_type=sa.INTEGER(),
               nullable=True)

    with op.batch_alter_table('list_items', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_list_items_parent_id'))
        batch_op.drop_column('parent_id')

    with op.batch_alter_table('focuses', schema=None) as batch_op:
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('committed',
               existing_type=sa.BOOLEAN(),
               server_default=sa.text('0'),
               existing_nullable=False)

    with op.batch_alter_table('backlog_tickets', schema=None) as batch_op:
        batch_op.alter_column('sort_order',
               existing_type=sa.INTEGER(),
               server_default=sa.text('0'),
               existing_nullable=False)
        batch_op.alter_column('done',
               existing_type=sa.BOOLEAN(),
               server_default=sa.text('0'),
               existing_nullable=False)
