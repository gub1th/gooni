"""promise v2 nuclear — drop + recreate with cadence cols

Ambient-loop v2 Slice 1. Nuclear per PRD (note #389): old Promise rows are
disposable, no migration shim. Drop the table and recreate with the new
shape (cadence, cadence_target, is_important, parent_promise_id).

Revision ID: e7a2c9b1d4f8
Revises: d9f1e2a3b4c5
Create Date: 2026-07-08
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e7a2c9b1d4f8"
down_revision = "d9f1e2a3b4c5"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("promises"):
        op.drop_table("promises")

    op.create_table(
        "promises",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cadence", sa.String(), nullable=False, server_default="once"),
        sa.Column("cadence_target", sa.Integer(), nullable=True),
        sa.Column(
            "is_important", sa.Boolean(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "parent_promise_id",
            sa.Integer(),
            sa.ForeignKey("promises.id"),
            nullable=True,
        ),
        sa.Column("utterance", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("inferred_due", sa.DateTime(), nullable=True),
        sa.Column("state", sa.String(), nullable=False, server_default="active"),
        sa.Column(
            "needs_clarification",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("slip_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column(
            "source_message_id",
            sa.Integer(),
            sa.ForeignKey("messages.id"),
            nullable=True,
        ),
        sa.Column("embedding", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    # if_not_exists guards: SQLite auto-commits DDL, so a crash between
    # create_table and the version stamp re-runs this block on next boot.
    op.create_index("ix_promises_id", "promises", ["id"], if_not_exists=True)
    op.create_index("ix_promises_state", "promises", ["state"], if_not_exists=True)
    op.create_index("ix_promises_cadence", "promises", ["cadence"], if_not_exists=True)
    op.create_index(
        "ix_promises_parent_promise_id",
        "promises",
        ["parent_promise_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_promises_source_message_id",
        "promises",
        ["source_message_id"],
        if_not_exists=True,
    )


def downgrade():
    # Nuclear forward-only. Old rows are gone either way; downgrade just
    # drops the new cols' table shape back to nothing useful.
    op.drop_table("promises")
