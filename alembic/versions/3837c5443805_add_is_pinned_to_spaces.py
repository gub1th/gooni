"""add is_pinned to spaces

Revision ID: 3837c5443805
Revises: 9116b827cb87
Create Date: 2026-05-18 00:32:03.620466

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3837c5443805'
down_revision: Union[str, Sequence[str], None] = '9116b827cb87'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add `is_pinned` so users can pin spaces (sort to top of sidebar)."""
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("spaces")}
    if "is_pinned" in cols:
        return
    with op.batch_alter_table("spaces", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default="0")
        )


def downgrade() -> None:
    with op.batch_alter_table("spaces", schema=None) as batch_op:
        batch_op.drop_column("is_pinned")
