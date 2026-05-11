"""add tool_calls audit table

Revision ID: 7e7a6d8e8c5d
Revises: 5e6cca5584da
Create Date: 2026-05-10 15:56:25.355466

Adds the tool_calls audit table. Substrate for the anti-hallucination layer:
every chat tool invocation gets a row tracking name, args, status, result,
and timing. Future ReAct work queries this for in-flight + historical
context across turns.

Autogen captured a lot of unrelated drift between models.py and prod schema
(server_default removals, parent_id FKs, retrieval_count NOT NULL, etc.) —
those are real drifts but unrelated to this feature, intentionally left out
so this migration is reviewable. They get their own cleanup PR.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7e7a6d8e8c5d'
down_revision: Union[str, Sequence[str], None] = '5e6cca5584da'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent: prod hit a crash-loop where a prior boot created the
    # table but the alembic_version stamp never committed (SQLite DDL
    # auto-commits, the version UPDATE is a separate txn — a kill between
    # the two leaves the table present and alembic stuck at down_revision).
    # Skip create_table if it's already there; do the same per-index so
    # half-applied states recover on the next boot.
    bind = op.get_bind()
    table_exists = 'tool_calls' in set(sa.inspect(bind).get_table_names())

    if not table_exists:
        op.create_table(
            'tool_calls',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('conversation_id', sa.Integer(), nullable=True),
            sa.Column('message_id', sa.Integer(), nullable=True),
            sa.Column('tool_name', sa.String(), nullable=False),
            sa.Column('args_json', sa.Text(), nullable=True),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('result_json', sa.Text(), nullable=True),
            sa.Column('error', sa.Text(), nullable=True),
            sa.Column('started_at', sa.DateTime(), nullable=False),
            sa.Column('finished_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id']),
            sa.ForeignKeyConstraint(['message_id'], ['messages.id']),
            sa.PrimaryKeyConstraint('id'),
        )

    existing_indexes = {ix['name'] for ix in sa.inspect(bind).get_indexes('tool_calls')}
    wanted = [
        ('ix_tool_calls_conversation_id', ['conversation_id']),
        ('ix_tool_calls_id', ['id']),
        ('ix_tool_calls_message_id', ['message_id']),
        ('ix_tool_calls_status', ['status']),
        ('ix_tool_calls_tool_name', ['tool_name']),
    ]
    with op.batch_alter_table('tool_calls', schema=None) as batch_op:
        for name, cols in wanted:
            if name not in existing_indexes:
                batch_op.create_index(batch_op.f(name), cols, unique=False)


def downgrade() -> None:
    with op.batch_alter_table('tool_calls', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tool_calls_tool_name'))
        batch_op.drop_index(batch_op.f('ix_tool_calls_status'))
        batch_op.drop_index(batch_op.f('ix_tool_calls_message_id'))
        batch_op.drop_index(batch_op.f('ix_tool_calls_id'))
        batch_op.drop_index(batch_op.f('ix_tool_calls_conversation_id'))
    op.drop_table('tool_calls')
