"""reminders.state + resolved_at — promise broken/kept lifecycle

Revision ID: b7e2f9a1c4d6
Revises: f9c2a7e14b60
Create Date: 2026-07-24

The said-vs-done thesis needs promises to carry a third state beyond the legacy
`done` boolean: 'active' | 'kept' | 'broken'. The dashboard renders a broken
promise in the warn colour with how long it lasted (created_at → resolved_at),
which is the gap rendering itself rather than being narrated.

Two nullable/defaulted ADD COLUMNs, so SQLite does them native + rebuild-free.
Idempotent inspector guard so re-runs / half-applied states are no-ops (the
column added first commits its DDL before the version stamp lands).
"""
from alembic import op
import sqlalchemy as sa


revision = "b7e2f9a1c4d6"
down_revision = "f9c2a7e14b60"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("reminders")]
    if "state" not in cols:
        op.add_column(
            "reminders",
            sa.Column("state", sa.String(), nullable=False, server_default="active"),
        )
        op.create_index("ix_reminders_state", "reminders", ["state"])
    if "resolved_at" not in cols:
        op.add_column("reminders", sa.Column("resolved_at", sa.DateTime(), nullable=True))


def downgrade():
    op.drop_index("ix_reminders_state", table_name="reminders")
    op.drop_column("reminders", "resolved_at")
    op.drop_column("reminders", "state")
