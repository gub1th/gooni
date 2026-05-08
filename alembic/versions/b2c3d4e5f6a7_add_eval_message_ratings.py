"""add eval_message_ratings

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-07

Per-message thumbs (1=bad, 2=meh, 3=good) on assistant replies. Step-level
EvalStepFeedback was too narrow and segment overall too coarse.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent: the legacy-cutover path (app/main.py:_alembic_upgrade)
    # runs Base.metadata.create_all before stamping baseline, which already
    # creates this table. Skip the create + index calls when it's there.
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("eval_message_ratings"):
        return

    op.create_table(
        "eval_message_ratings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("segment_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["segment_id"], ["eval_segments.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id", name="uq_eval_message_rating_message"),
    )
    with op.batch_alter_table("eval_message_ratings", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_eval_message_ratings_id"), ["id"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_eval_message_ratings_segment_id"), ["segment_id"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_eval_message_ratings_message_id"), ["message_id"], unique=True
        )


def downgrade() -> None:
    with op.batch_alter_table("eval_message_ratings", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_eval_message_ratings_message_id"))
        batch_op.drop_index(batch_op.f("ix_eval_message_ratings_segment_id"))
        batch_op.drop_index(batch_op.f("ix_eval_message_ratings_id"))
    op.drop_table("eval_message_ratings")
