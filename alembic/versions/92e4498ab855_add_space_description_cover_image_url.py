"""add space description + cover_image_url

Revision ID: 92e4498ab855
Revises: 28b40f3a86d5
Create Date: 2026-05-18 03:19:18.593642

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '92e4498ab855'
down_revision: Union[str, Sequence[str], None] = '28b40f3a86d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add description + cover_image_url so spaces can carry their own
    long-form identity (header on the space view), not just a name+emoji."""
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("spaces")}
    with op.batch_alter_table("spaces", schema=None) as batch_op:
        if "description" not in cols:
            batch_op.add_column(sa.Column("description", sa.Text(), nullable=True))
        if "cover_image_url" not in cols:
            batch_op.add_column(sa.Column("cover_image_url", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("spaces", schema=None) as batch_op:
        batch_op.drop_column("cover_image_url")
        batch_op.drop_column("description")
