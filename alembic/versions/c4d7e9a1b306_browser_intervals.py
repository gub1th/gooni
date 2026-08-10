"""browser_intervals — raw browser-attention sensor rows

Revision ID: c4d7e9a1b306
Revises: f4c81a92de70
Create Date: 2026-08-08

One row per stretch of browser attention, written by the Chrome extension in
`extension/` (POST /browser/intervals). Deliberately its OWN table rather than
a Trackable: attribution — binding observed attention to a declared
Topic/Promise — is a separate later design, and landing this in the trackable
surface first would produce confidently wrong focus percentages.

`client_id` is UNIQUE: the extension mints it when an interval closes and it
survives every retry, so a redelivered batch dedups instead of double-counting
(the WaProcessedId.wamid pattern).

Idempotent: inspector guards + if_not_exists on indexes, so re-runs and
half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "c4d7e9a1b306"
down_revision = "b8f3d1c07a45"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("browser_intervals"):
        op.create_table(
            "browser_intervals",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("host", sa.String(), nullable=False),
            sa.Column("path", sa.Text(), nullable=True),
            sa.Column("url", sa.Text(), nullable=True),
            sa.Column("title", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("ended_at", sa.DateTime(), nullable=False),
            sa.Column("duration_sec", sa.Float(), nullable=False),
            sa.Column("end_reason", sa.String(), nullable=True),
            sa.Column(
                "truncated", sa.Boolean(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column(
                "source",
                sa.String(),
                nullable=False,
                server_default="chrome_extension",
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )

    op.create_index(
        "ix_browser_intervals_id", "browser_intervals", ["id"], if_not_exists=True
    )
    # UNIQUE — the idempotency boundary, not just a lookup index.
    op.create_index(
        "ix_browser_intervals_client_id",
        "browser_intervals",
        ["client_id"],
        unique=True,
        if_not_exists=True,
    )
    op.create_index(
        "ix_browser_intervals_host", "browser_intervals", ["host"], if_not_exists=True
    )
    op.create_index(
        "ix_browser_intervals_started_at",
        "browser_intervals",
        ["started_at"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_browser_intervals_source",
        "browser_intervals",
        ["source"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_browser_intervals_created_at",
        "browser_intervals",
        ["created_at"],
        if_not_exists=True,
    )
    # The read a later attribution layer wants: "this host, this window".
    op.create_index(
        "ix_browser_intervals_host_started",
        "browser_intervals",
        ["host", "started_at"],
        if_not_exists=True,
    )


def downgrade():
    op.drop_table("browser_intervals")
