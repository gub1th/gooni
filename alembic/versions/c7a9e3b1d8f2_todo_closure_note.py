"""todo closure_note column

Revision ID: c7a9e3b1d8f2
Revises: a81aca926fb7
Create Date: 2026-05-20 02:00:00.000000

G3.5 Todo Continuity: adds `closure_note` (TEXT, nullable) to `todos`.
Captures short inline outcome text when a todo closes. Most closes have
nothing to say — column is nullable. Longer outcomes get written as a
Note with an `outcome_of` edge instead (no schema work needed there;
edges table already supports arbitrary kinds).

Inspector-guarded — re-runs are no-ops. Drops cleanly on downgrade.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c7a9e3b1d8f2"
down_revision: Union[str, Sequence[str], None] = "a81aca926fb7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(bind, table: str, col: str) -> bool:
    return any(
        c["name"] == col for c in sa.inspect(bind).get_columns(table)
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("todos"):
        return
    if not _has_column(bind, "todos", "closure_note"):
        op.add_column(
            "todos",
            sa.Column("closure_note", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("todos"):
        return
    if _has_column(bind, "todos", "closure_note"):
        op.drop_column("todos", "closure_note")
