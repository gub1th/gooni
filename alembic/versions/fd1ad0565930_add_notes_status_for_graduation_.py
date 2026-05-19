"""add notes.status for graduation lifecycle

Revision ID: fd1ad0565930
Revises: 92e4498ab855
Create Date: 2026-05-18 18:11:06.365015

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fd1ad0565930'
down_revision: Union[str, Sequence[str], None] = '92e4498ab855'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add notes.status (unprocessed|graduated|archived) + index.

    Inspector-guarded for self-healing re-runs per the half-applied-state
    recovery convention in app/main._alembic_upgrade.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("notes")}
    if "status" not in cols:
        op.add_column(
            "notes",
            sa.Column(
                "status",
                sa.String(),
                nullable=False,
                server_default="unprocessed",
            ),
        )
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("notes")}
    if "ix_notes_status" not in existing_indexes:
        op.create_index("ix_notes_status", "notes", ["status"])


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("notes")}
    if "ix_notes_status" in existing_indexes:
        op.drop_index("ix_notes_status", table_name="notes")
    cols = {c["name"] for c in inspector.get_columns("notes")}
    if "status" in cols:
        op.drop_column("notes", "status")
