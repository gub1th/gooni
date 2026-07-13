"""memory source_message_id — chat provenance twin of source_note_id

Revision ID: c7e9a1f4b2d8
Revises: 884013e244b2
Create Date: 2026-07-12

Adds Memory.source_message_id (nullable FK-shaped int → messages.id) so
chat-derived memories record the user utterance that spawned them, mirroring
the existing source_note_id. No FK constraint emitted here — SQLite doesn't
enforce them and a fresh DB gets the constraint from the model. Idempotent:
inspector guards so re-runs and half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "c7e9a1f4b2d8"
down_revision = "884013e244b2"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("memories")]
    if "source_message_id" not in cols:
        # SQLite ADD COLUMN is native + rebuild-free for a nullable column.
        op.add_column("memories", sa.Column("source_message_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_memories_source_message_id", "memories", ["source_message_id"], if_not_exists=True
    )


def downgrade():
    op.drop_index("ix_memories_source_message_id", table_name="memories")
    op.drop_column("memories", "source_message_id")
