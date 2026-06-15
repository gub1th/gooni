"""drop limbo_items table

Revision ID: d9f1e2a3b4c5
Revises: f3a9c1d2e4b5
Create Date: 2026-06-11

"""
from alembic import op
import sqlalchemy as sa

revision = "d9f1e2a3b4c5"
down_revision = "f3a9c1d2e4b5"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if sa.inspect(bind).has_table("limbo_items"):
        op.drop_table("limbo_items")


def downgrade():
    op.create_table(
        "limbo_items",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("source_message_id", sa.Integer, sa.ForeignKey("messages.id"), nullable=True, index=True),
        sa.Column("kind_hint", sa.String, nullable=True),
        sa.Column("mention_count", sa.Integer, default=1, nullable=False),
        sa.Column("status", sa.String, nullable=False, default="limbo"),
        sa.Column("promoted_to_type", sa.String, nullable=True),
        sa.Column("promoted_to_id", sa.Integer, nullable=True),
        sa.Column("embedding", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
