"""whoop snapshot source_updated_at

Revision ID: b49c74cbe9ff
Revises: d8e4ca09b2f3
Create Date: 2026-05-20 20:02:00.151132

Adds `whoop_snapshots.source_updated_at` — newest upstream record
`updated_at` across recovery/cycle/sleep. Distinct from the existing
`updated_at` column (when we last polled + cached the row); this one
reflects when Whoop itself last scored data. Drives the freshness
label on the StatsView Whoop card so "updated 18h ago" reflects
Daniel's actual data age, not our cache poll.

Autogenerate emitted a wall of cosmetic SQLite drift (INTEGER↔Boolean,
DATETIME types, FTS table churn) — stripped, since the production DB
is already past baseline + drift is type-cosmetic only.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b49c74cbe9ff'
down_revision: Union[str, Sequence[str], None] = 'd8e4ca09b2f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("whoop_snapshots")}
    if "source_updated_at" not in cols:
        with op.batch_alter_table("whoop_snapshots", schema=None) as batch_op:
            batch_op.add_column(sa.Column("source_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("whoop_snapshots", schema=None) as batch_op:
        batch_op.drop_column("source_updated_at")
