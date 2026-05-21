"""merge claimed_by + reactions + notes_icon heads

Revision ID: bbee0ed18a80
Revises: a3f9e1c5b2d8, b9f1c4a2e8d3, dd57efb3a5d7
Create Date: 2026-05-21 10:58:40.233377

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'bbee0ed18a80'
down_revision: Union[str, Sequence[str], None] = ('a3f9e1c5b2d8', 'b9f1c4a2e8d3', 'dd57efb3a5d7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
