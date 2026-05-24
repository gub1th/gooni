"""add limbo_items table + settings.batch_last_run_day

Revision ID: c4e8d2a9f1b7
Revises: b2f4a1c7d3e9
Create Date: 2026-05-24 14:00:00.000000

PR-3 ambient-loop pivot. LimboItem = raw staging primitive written by the
5am batch processor; batch_last_run_day = the batch's idempotency stamp.
Inspector-guarded so re-runs against a partially-applied DB are no-ops.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e8d2a9f1b7'
down_revision: Union[str, Sequence[str], None] = 'b2f4a1c7d3e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if 'limbo_items' not in set(inspector.get_table_names()):
        op.create_table(
            'limbo_items',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('text', sa.Text(), nullable=False),
            sa.Column('source_message_id', sa.Integer(), nullable=True),
            sa.Column('kind_hint', sa.String(), nullable=True),
            sa.Column('mention_count', sa.Integer(), nullable=False, server_default='1'),
            sa.Column('status', sa.String(), nullable=False, server_default='limbo'),
            sa.Column('promoted_to_type', sa.String(), nullable=True),
            sa.Column('promoted_to_id', sa.Integer(), nullable=True),
            sa.Column('embedding', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(['source_message_id'], ['messages.id']),
            sa.PrimaryKeyConstraint('id'),
        )

    existing_indexes = {
        ix['name'] for ix in sa.inspect(bind).get_indexes('limbo_items')
    }
    with op.batch_alter_table('limbo_items', schema=None) as batch_op:
        if 'ix_limbo_items_id' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_limbo_items_id'), ['id'], unique=False)
        if 'ix_limbo_items_source_message_id' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_limbo_items_source_message_id'), ['source_message_id'], unique=False)
        if 'ix_limbo_items_status' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_limbo_items_status'), ['status'], unique=False)

    settings_cols = {c['name'] for c in sa.inspect(bind).get_columns('settings')}
    if 'batch_last_run_day' not in settings_cols:
        op.add_column('settings', sa.Column('batch_last_run_day', sa.String(), nullable=True))


def downgrade() -> None:
    settings_cols = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('settings')}
    if 'batch_last_run_day' in settings_cols:
        op.drop_column('settings', 'batch_last_run_day')
    with op.batch_alter_table('limbo_items', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_limbo_items_status'))
        batch_op.drop_index(batch_op.f('ix_limbo_items_source_message_id'))
        batch_op.drop_index(batch_op.f('ix_limbo_items_id'))
    op.drop_table('limbo_items')
