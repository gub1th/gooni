"""re-add notes.excerpt dropped by 40c7d78ffa45

The previous migration's _DEAD list incorrectly included `excerpt` because
its model snapshot predated PR #139 (which added the column). Prod DBs
that already ran 40c7d78ffa45 lost the column, and any subsequent ORM
read/write of Note.excerpt 500s with `no such column: notes.excerpt`.

This migration re-adds the column. Idempotent guard via PRAGMA so fresh
DBs (whose baseline already contains `excerpt`) don't error on re-run.
The lazy backfill loop in `_lifespan` fills NULL rows once boot finishes.

Revision ID: a1b2c3d4e5f6
Revises: 40c7d78ffa45
Create Date: 2026-05-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '40c7d78ffa45'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, col: str) -> bool:
    bind = op.get_bind()
    return any(r[1] == col for r in bind.execute(sa.text(f"PRAGMA table_info({table})")))


def upgrade() -> None:
    if not _has_column("notes", "excerpt"):
        with op.batch_alter_table("notes") as batch:
            batch.add_column(sa.Column("excerpt", sa.Text(), nullable=True))


def downgrade() -> None:
    if _has_column("notes", "excerpt"):
        with op.batch_alter_table("notes") as batch:
            batch.drop_column("excerpt")
