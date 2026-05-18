"""add tags to notes

Revision ID: 5503af7a71e6
Revises: 3837c5443805
Create Date: 2026-05-18 01:01:58.670897

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5503af7a71e6'
down_revision: Union[str, Sequence[str], None] = '3837c5443805'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add `tags` JSON-text column to notes for free-form user/agent labels."""
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("notes")}
    if "tags" in cols:
        return
    with op.batch_alter_table("notes", schema=None) as batch_op:
        batch_op.add_column(sa.Column("tags", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("notes", schema=None) as batch_op:
        batch_op.drop_column("tags")
