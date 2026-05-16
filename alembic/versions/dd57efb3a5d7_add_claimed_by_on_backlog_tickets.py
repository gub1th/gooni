"""add claimed_by on backlog_tickets

Revision ID: dd57efb3a5d7
Revises: 3d057ff39f90
Create Date: 2026-05-15 18:32:08.384485

Adds a free-text `claimed_by` column so the backlog board can surface
who-is-driving attribution (e.g. a "🤖 claude picked up" pill while
Claude Code is actively working a ticket).

Autogen drift was massive (legacy SQLite quirks + dead tables); this
revision was scrubbed by hand down to the one real change.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'dd57efb3a5d7'
down_revision: Union[str, Sequence[str], None] = '3d057ff39f90'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c['name'] for c in sa.inspect(bind).get_columns('backlog_tickets')}
    if 'claimed_by' in cols:
        return
    with op.batch_alter_table('backlog_tickets', schema=None) as batch_op:
        batch_op.add_column(sa.Column('claimed_by', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('backlog_tickets', schema=None) as batch_op:
        batch_op.drop_column('claimed_by')
