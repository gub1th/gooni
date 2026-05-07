"""drop dead columns from notes + spaces

These columns hung around from older schema versions and aren't referenced
anywhere in the model or app code. Confirmed unused via grep across
app/, frontend/src/, scripts/. SQLite can't DROP COLUMN directly, so
batch_alter_table rewrites the table behind the scenes.

Idempotent guard: skips drop if the column doesn't exist (covers fresh
DBs created from baseline, which already lack these columns).

Revision ID: 40c7d78ffa45
Revises: ebbf04b84ba5
Create Date: 2026-05-07 03:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '40c7d78ffa45'
down_revision: Union[str, Sequence[str], None] = 'ebbf04b84ba5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEAD = {
    "notes": ["outcome", "excerpt", "log_date", "goal_id", "meta", "pinned_sort_order", "note_type"],
    "spaces": ["sort_order"],
}


def _existing_cols(table: str) -> set[str]:
    bind = op.get_bind()
    return {r[1] for r in bind.execute(sa.text(f"PRAGMA table_info({table})"))}


def upgrade() -> None:
    for table, cols in _DEAD.items():
        present = _existing_cols(table)
        to_drop = [c for c in cols if c in present]
        if not to_drop:
            continue
        with op.batch_alter_table(table) as batch:
            for col in to_drop:
                batch.drop_column(col)


def downgrade() -> None:
    # Dead columns are dead — no need to recreate them on downgrade.
    pass
