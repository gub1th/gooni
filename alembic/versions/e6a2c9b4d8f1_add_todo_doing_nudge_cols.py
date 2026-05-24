"""add todo doing_started_at + last_nudge_sent_at

Revision ID: e6a2c9b4d8f1
Revises: d5f1b3e7a2c9
Create Date: 2026-05-24 16:00:00.000000

PR-6 ambient-loop — procrastination nudge. Inspector-guarded.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e6a2c9b4d8f1'
down_revision: Union[str, Sequence[str], None] = 'd5f1b3e7a2c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    cols = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('todos')}
    if 'doing_started_at' not in cols:
        op.add_column('todos', sa.Column('doing_started_at', sa.DateTime(), nullable=True))
    if 'last_nudge_sent_at' not in cols:
        op.add_column('todos', sa.Column('last_nudge_sent_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    cols = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('todos')}
    if 'last_nudge_sent_at' in cols:
        op.drop_column('todos', 'last_nudge_sent_at')
    if 'doing_started_at' in cols:
        op.drop_column('todos', 'doing_started_at')
