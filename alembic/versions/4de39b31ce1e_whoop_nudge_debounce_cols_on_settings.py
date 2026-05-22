"""whoop nudge debounce cols on settings

Revision ID: 4de39b31ce1e
Revises: afd530e8a888
Create Date: 2026-05-22 11:52:48.183941

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4de39b31ce1e'
down_revision: Union[str, Sequence[str], None] = 'afd530e8a888'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add 2 debounce cols. Inspector-guarded so re-runs are no-ops."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("settings")}

    with op.batch_alter_table("settings", schema=None) as batch_op:
        if "whoop_nudge_pending_source_ts" not in existing:
            batch_op.add_column(
                sa.Column("whoop_nudge_pending_source_ts", sa.DateTime(), nullable=True)
            )
        if "whoop_nudge_pending_set_at" not in existing:
            batch_op.add_column(
                sa.Column("whoop_nudge_pending_set_at", sa.DateTime(), nullable=True)
            )


def downgrade() -> None:
    with op.batch_alter_table("settings", schema=None) as batch_op:
        batch_op.drop_column("whoop_nudge_pending_set_at")
        batch_op.drop_column("whoop_nudge_pending_source_ts")
