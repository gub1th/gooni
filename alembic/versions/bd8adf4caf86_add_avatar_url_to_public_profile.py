"""add avatar_url to public_profile

Revision ID: bd8adf4caf86
Revises: d4e1f2a3b5c8
Create Date: 2026-05-09 03:05:11.518671

The autogen pass produced a kitchen-sink diff because the local dev DB is
behind on legacy SQLite type drift; the only intended change is the new
public_profile.avatar_url column. Migration manually narrowed to that.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'bd8adf4caf86'
down_revision: Union[str, Sequence[str], None] = 'd4e1f2a3b5c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('public_profile', schema=None) as batch_op:
        batch_op.add_column(sa.Column('avatar_url', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('public_profile', schema=None) as batch_op:
        batch_op.drop_column('avatar_url')
