"""add habits + habit_entries tables

Revision ID: a0efb28c711f
Revises: c9d4a7b1e2f3
Create Date: 2026-05-13 21:46:11.626240

Narrow scope: only the two new tables + their indexes. Autogen also
re-surfaced the same SQLite cosmetic drift + legacy-backup cleanup
as prior migrations; deferred to its dedicated PR.

Idempotency note: an earlier prod deploy partially executed this
migration — CREATE TABLE habits succeeded but alembic never stamped
the revision (the deploy crashed mid-way), so the retry hit
"table habits already exists" → boot loop. Each DDL op is now guarded
against pre-existing state via sqlalchemy inspect(), so the migration
is safe to re-run from any partial state. Same pattern as PR #185
(tool_calls) and PR #197 (focus-synth chain).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a0efb28c711f'
down_revision: Union[str, Sequence[str], None] = 'c9d4a7b1e2f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema. Idempotent against partial prior runs."""
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    existing_tables = set(inspector.get_table_names())

    # ── habits ────────────────────────────────────────────────────────
    if 'habits' not in existing_tables:
        op.create_table(
            'habits',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('name', sa.Text(), nullable=False),
            sa.Column('color', sa.String(), nullable=True),
            sa.Column(
                'polarity', sa.String(),
                nullable=False, server_default='positive',
            ),
            sa.Column('archived_at', sa.DateTime(), nullable=True),
            sa.Column(
                'sort_order', sa.Integer(),
                nullable=False, server_default='0',
            ),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('id'),
        )

    existing_habits_indexes = (
        {ix['name'] for ix in inspector.get_indexes('habits')}
        if 'habits' in existing_tables else set()
    )
    with op.batch_alter_table('habits', schema=None) as batch_op:
        if 'ix_habits_id' not in existing_habits_indexes:
            batch_op.create_index(batch_op.f('ix_habits_id'), ['id'], unique=False)

    # ── habit_entries ─────────────────────────────────────────────────
    # Refresh table list — habits may have been created just above.
    existing_tables = set(inspect(bind).get_table_names())
    if 'habit_entries' not in existing_tables:
        op.create_table(
            'habit_entries',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('habit_id', sa.Integer(), nullable=False),
            sa.Column('date', sa.Date(), nullable=False),
            sa.Column('value', sa.Boolean(), nullable=False),
            sa.Column('note', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(['habit_id'], ['habits.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('habit_id', 'date', name='uq_habit_entry_per_day'),
        )

    existing_entry_indexes = (
        {ix['name'] for ix in inspect(bind).get_indexes('habit_entries')}
        if 'habit_entries' in existing_tables else set()
    )
    wanted_entry_indexes = [
        ('ix_habit_entries_date', ['date'], False),
        ('ix_habit_entries_habit_id', ['habit_id'], False),
        ('ix_habit_entries_id', ['id'], False),
    ]
    with op.batch_alter_table('habit_entries', schema=None) as batch_op:
        for name, cols, unique in wanted_entry_indexes:
            if name in existing_entry_indexes:
                continue
            batch_op.create_index(batch_op.f(name), cols, unique=unique)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('habit_entries', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_habit_entries_id'))
        batch_op.drop_index(batch_op.f('ix_habit_entries_habit_id'))
        batch_op.drop_index(batch_op.f('ix_habit_entries_date'))
    op.drop_table('habit_entries')
    with op.batch_alter_table('habits', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_habits_id'))
    op.drop_table('habits')
