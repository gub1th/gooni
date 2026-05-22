"""add proactive nudge idempotency cols to settings

Revision ID: f747aa60b5b5
Revises: bbee0ed18a80
Create Date: 2026-05-22 01:55:56.290849

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f747aa60b5b5'
down_revision: Union[str, Sequence[str], None] = 'bbee0ed18a80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add three proactive-nudge idempotency cols on Settings.

    Inspector-guarded so re-runs are no-ops, matching the project
    convention in CLAUDE.md — lets `_alembic_upgrade` self-heal on
    partially-applied state.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("settings")}

    with op.batch_alter_table("settings", schema=None) as batch_op:
        if "last_whoop_nudge_source_ts" not in existing:
            batch_op.add_column(
                sa.Column("last_whoop_nudge_source_ts", sa.DateTime(), nullable=True)
            )
        if "last_sleep_nudge_day" not in existing:
            batch_op.add_column(
                sa.Column("last_sleep_nudge_day", sa.String(), nullable=True)
            )
        if "sleep_cutoff_hour" not in existing:
            batch_op.add_column(
                sa.Column("sleep_cutoff_hour", sa.Integer(), nullable=True)
            )


def downgrade() -> None:
    """Drop the cols. Best-effort; SQLite drop_column needs batch_alter_table."""
    with op.batch_alter_table("settings", schema=None) as batch_op:
        batch_op.drop_column("sleep_cutoff_hour")
        batch_op.drop_column("last_sleep_nudge_day")
        batch_op.drop_column("last_whoop_nudge_source_ts")
