"""app_intervals — raw desktop frontmost-app sensor rows

Revision ID: a5c81f30d7e2
Revises: e2b71c9f4a08
Create Date: 2026-08-12

The OS twin of `browser_intervals`, written by the Electron shell
(POST /app/intervals). Its own table rather than a `source` discriminator on
browser_intervals: `host` is a hostname and `app` is an application name, and
every existing browser read (the extension popup's per-host ranking, the SQL
summarize fold, GET /browser/intervals) would have to grow a filter it doesn't
need today, with an app listed as a visited domain as the cost of missing one.
See AppInterval's docstring in app/db/models.py.

`client_id` is UNIQUE — the shell mints it when an interval closes and it
survives every retry, so a redelivered batch dedups instead of double-counting.

Idempotent: inspector guards + if_not_exists on indexes, so re-runs and
half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "a5c81f30d7e2"
down_revision = "e2b71c9f4a08"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("app_intervals"):
        op.create_table(
            "app_intervals",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("app", sa.String(), nullable=False),
            sa.Column("title", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("ended_at", sa.DateTime(), nullable=False),
            sa.Column("duration_sec", sa.Float(), nullable=False),
            sa.Column("end_reason", sa.String(), nullable=True),
            sa.Column(
                "truncated", sa.Boolean(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column(
                "source", sa.String(), nullable=False, server_default="desktop_shell"
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )

    op.create_index("ix_app_intervals_id", "app_intervals", ["id"], if_not_exists=True)
    # UNIQUE — the idempotency boundary, not just a lookup index.
    op.create_index(
        "ix_app_intervals_client_id",
        "app_intervals",
        ["client_id"],
        unique=True,
        if_not_exists=True,
    )
    op.create_index("ix_app_intervals_app", "app_intervals", ["app"], if_not_exists=True)
    op.create_index(
        "ix_app_intervals_started_at", "app_intervals", ["started_at"], if_not_exists=True
    )
    op.create_index(
        "ix_app_intervals_source", "app_intervals", ["source"], if_not_exists=True
    )
    op.create_index(
        "ix_app_intervals_created_at", "app_intervals", ["created_at"], if_not_exists=True
    )
    # The read the "opened X" derivation wants: this app, this window.
    op.create_index(
        "ix_app_intervals_app_started",
        "app_intervals",
        ["app", "started_at"],
        if_not_exists=True,
    )


def downgrade():
    op.drop_table("app_intervals")
