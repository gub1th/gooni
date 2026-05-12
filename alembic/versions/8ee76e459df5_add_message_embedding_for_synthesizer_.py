"""add Message.embedding for synthesizer cache

Revision ID: 8ee76e459df5
Revises: e4fce556f864
Create Date: 2026-05-11 23:29:34.855169

Narrow scope: only adds the new column. Autogen also surfaced a large
backlog of SQLite cosmetic drift (TEXT→String, INTEGER→Boolean, NULL/NOT
NULL flips) and stale legacy-backup tables — none of that is shipped
here; those changes belong in their own dedicated cleanup migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8ee76e459df5'
down_revision: Union[str, Sequence[str], None] = 'e4fce556f864'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema. Idempotent: paired with the focus-candidates partial
    deploy, this column may already exist from an earlier crashed run."""
    from sqlalchemy import inspect
    bind = op.get_bind()
    existing = {c['name'] for c in inspect(bind).get_columns('messages')}
    if 'embedding' in existing:
        return
    with op.batch_alter_table('messages', schema=None) as batch_op:
        batch_op.add_column(sa.Column('embedding', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('messages', schema=None) as batch_op:
        batch_op.drop_column('embedding')
