"""note embedded_at: sweeper staleness gate

Adds ONE nullable column. Hand-written, not autogenerate output: running
autogenerate against a local DB that isn't at head produced a migration
that dropped `notes_fts`, `memories_fts_*` and every legacy table the v2
nuke already removed. Same trap `1aee2da7e158` documents — the FTS virtual
tables are created by triggers/migrations that autogenerate can't see, so it
reads them as drift.

Backfill is deliberately NULL, not `updated_at`: null means "never embedded
by the sweeper", which is exactly what is true, and it makes every existing
note eligible for one pass. Stamping `updated_at` would claim vectors are
current when many pre-date their note's last edit.

Revision ID: 2d8404bfd652
Revises: b2f7c34ae901
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2d8404bfd652"
down_revision: Union[str, Sequence[str], None] = "b2f7c34ae901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("notes")}
    if "embedded_at" not in cols:
        op.add_column("notes", sa.Column("embedded_at", sa.DateTime(), nullable=True))
    op.create_index(
        "ix_notes_embedded_at", "notes", ["embedded_at"], unique=False, if_not_exists=True
    )


def downgrade() -> None:
    op.drop_index("ix_notes_embedded_at", table_name="notes", if_exists=True)
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("notes")}
    if "embedded_at" in cols:
        op.drop_column("notes", "embedded_at")
