"""todo recurrence counter cols (G3)

Revision ID: 5b16a0f9617d
Revises: c7a9e3b1d8f2
Create Date: 2026-05-20 01:02:09.614261

Adds the columns G3 needs to track how many times Daniel has re-mentioned
each open todo. On new-todo create, todo_service cosine-matches the text
against open todos at ≥0.85; on hit it bumps these cols on the existing
row INSTEAD of inserting a duplicate. Accountability ack uses the count
to escalate tone at ≥3.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5b16a0f9617d'
down_revision: Union[str, Sequence[str], None] = 'c7a9e3b1d8f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _todos_cols(bind):
    return {c["name"] for c in sa.inspect(bind).get_columns("todos")}


def _todos_indexes(bind):
    return {i["name"] for i in sa.inspect(bind).get_indexes("todos")}


def upgrade() -> None:
    """Add Todo recurrence-counter cols. Inspector-guarded per project
    convention so re-runs on partially-applied DBs are no-ops.
    """
    bind = op.get_bind()
    cols = _todos_cols(bind)

    with op.batch_alter_table("todos", schema=None) as batch_op:
        if "mention_count" not in cols:
            batch_op.add_column(
                sa.Column("mention_count", sa.Integer(), nullable=False, server_default="1")
            )
        if "last_mentioned_at" not in cols:
            batch_op.add_column(
                sa.Column("last_mentioned_at", sa.DateTime(), nullable=True)
            )
        if "mention_history" not in cols:
            batch_op.add_column(
                sa.Column("mention_history", sa.Text(), nullable=True)
            )

    indexes = _todos_indexes(bind)
    if "ix_todos_last_mentioned_at" not in indexes:
        with op.batch_alter_table("todos", schema=None) as batch_op:
            batch_op.create_index(
                "ix_todos_last_mentioned_at", ["last_mentioned_at"], unique=False
            )


def downgrade() -> None:
    """Drop the three Todo recurrence cols + their index."""
    bind = op.get_bind()
    indexes = _todos_indexes(bind)
    if "ix_todos_last_mentioned_at" in indexes:
        with op.batch_alter_table("todos", schema=None) as batch_op:
            batch_op.drop_index("ix_todos_last_mentioned_at")

    cols = _todos_cols(bind)
    with op.batch_alter_table("todos", schema=None) as batch_op:
        if "mention_history" in cols:
            batch_op.drop_column("mention_history")
        if "last_mentioned_at" in cols:
            batch_op.drop_column("last_mentioned_at")
        if "mention_count" in cols:
            batch_op.drop_column("mention_count")
