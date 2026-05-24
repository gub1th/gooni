"""add note session-summary columns

Revision ID: d5f1b3e7a2c9
Revises: c4e8d2a9f1b7
Create Date: 2026-05-24 15:00:00.000000

PR-4 ambient-loop. note_type + session bounds + message_count so the 5am
batch can write reviewable session-summary notes. Inspector-guarded.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd5f1b3e7a2c9'
down_revision: Union[str, Sequence[str], None] = 'c4e8d2a9f1b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c['name'] for c in sa.inspect(bind).get_columns('notes')}
    if 'note_type' not in cols:
        op.add_column('notes', sa.Column('note_type', sa.String(), nullable=True))
        with op.batch_alter_table('notes', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_notes_note_type'), ['note_type'], unique=False)
    if 'session_start' not in cols:
        op.add_column('notes', sa.Column('session_start', sa.DateTime(), nullable=True))
    if 'session_end' not in cols:
        op.add_column('notes', sa.Column('session_end', sa.DateTime(), nullable=True))
    if 'message_count' not in cols:
        op.add_column('notes', sa.Column('message_count', sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c['name'] for c in sa.inspect(bind).get_columns('notes')}
    if 'note_type' in cols:
        with op.batch_alter_table('notes', schema=None) as batch_op:
            batch_op.drop_index(batch_op.f('ix_notes_note_type'))
        op.drop_column('notes', 'note_type')
    for c in ('session_start', 'session_end', 'message_count'):
        if c in cols:
            op.drop_column('notes', c)
