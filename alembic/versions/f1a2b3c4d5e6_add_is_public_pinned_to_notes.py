"""add is_public_pinned to notes

Revision ID: f1a2b3c4d5e6
Revises: e4fce556f864
Create Date: 2026-05-12

Separate from is_pinned (sidebar). Pins a note as the hero card on the
/public page so the YC-facing landing can lead with an explainer note
without polluting the owner's working sidebar pin slot.
"""
from alembic import op
import sqlalchemy as sa


revision = "f1a2b3c4d5e6"
down_revision = "e4fce556f864"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("notes") as batch_op:
        batch_op.add_column(
            sa.Column(
                "is_public_pinned",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("notes") as batch_op:
        batch_op.drop_column("is_public_pinned")
