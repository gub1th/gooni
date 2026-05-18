"""allow null rating on eval_message_ratings

Revision ID: 9116b827cb87
Revises: dc60f5d23f85
Create Date: 2026-05-18 00:22:46.319503

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9116b827cb87'
down_revision: Union[str, Sequence[str], None] = 'dc60f5d23f85'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Allow rating to be NULL so reviewers can save a standalone comment
    without picking a thumbs. Comment was previously gated on rating in the
    UI, which silently discarded notes when the user clicked Save before
    rating."""
    with op.batch_alter_table('eval_message_ratings', schema=None) as batch_op:
        batch_op.alter_column(
            'rating',
            existing_type=sa.Integer(),
            nullable=True,
        )


def downgrade() -> None:
    with op.batch_alter_table('eval_message_ratings', schema=None) as batch_op:
        batch_op.alter_column(
            'rating',
            existing_type=sa.Integer(),
            nullable=False,
        )
