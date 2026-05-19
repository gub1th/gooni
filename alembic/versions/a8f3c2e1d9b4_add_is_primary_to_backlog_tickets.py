"""add is_primary singleton to backlog_tickets

Revision ID: a8f3c2e1d9b4
Revises: fd1ad0565930
Create Date: 2026-05-19 06:20:00

Adds a singleton flag on `backlog_tickets` so Daniel can pin exactly one
ticket as the dashboard "north star" banner. Mirrors `Todo.is_primary`
— service layer enforces the singleton invariant (any promote-to-primary
call clears the previous primary).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a8f3c2e1d9b4"
down_revision: Union[str, Sequence[str], None] = "fd1ad0565930"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Inspector-guarded — re-runs after a half-applied deploy are a no-op."""
    from sqlalchemy import inspect

    bind = op.get_bind()
    inspector = inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("backlog_tickets")}
    if "is_primary" in existing_cols:
        return
    with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "is_primary",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
        batch_op.drop_column("is_primary")
