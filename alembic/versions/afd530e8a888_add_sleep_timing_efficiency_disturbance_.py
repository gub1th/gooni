"""add sleep timing + efficiency + disturbance to whoop_snapshots

Revision ID: afd530e8a888
Revises: f747aa60b5b5
Create Date: 2026-05-22 02:16:50.281095

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'afd530e8a888'
down_revision: Union[str, Sequence[str], None] = 'f747aa60b5b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add 4 sleep-detail cols to whoop_snapshots. Inspector-guarded so
    re-runs are no-ops, matching the CLAUDE.md convention."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("whoop_snapshots")}

    with op.batch_alter_table("whoop_snapshots", schema=None) as batch_op:
        if "sleep_start_at" not in existing:
            batch_op.add_column(
                sa.Column("sleep_start_at", sa.DateTime(), nullable=True)
            )
        if "sleep_end_at" not in existing:
            batch_op.add_column(
                sa.Column("sleep_end_at", sa.DateTime(), nullable=True)
            )
        if "sleep_efficiency_pct" not in existing:
            batch_op.add_column(
                sa.Column("sleep_efficiency_pct", sa.Float(), nullable=True)
            )
        if "sleep_disturbance_count" not in existing:
            batch_op.add_column(
                sa.Column("sleep_disturbance_count", sa.Integer(), nullable=True)
            )


def downgrade() -> None:
    with op.batch_alter_table("whoop_snapshots", schema=None) as batch_op:
        batch_op.drop_column("sleep_disturbance_count")
        batch_op.drop_column("sleep_efficiency_pct")
        batch_op.drop_column("sleep_end_at")
        batch_op.drop_column("sleep_start_at")
