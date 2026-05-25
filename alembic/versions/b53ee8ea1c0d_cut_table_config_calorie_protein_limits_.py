"""cut table config: calorie/protein limits + cut start date

Revision ID: b53ee8ea1c0d
Revises: e6a2c9b4d8f1
Create Date: 2026-05-25 00:09:56.286869

Hand-trimmed: autogenerate swept in unrelated pre-existing drift (FTS virtual
tables, server_default mismatches, FKs SQLite doesn't enforce). This revision
adds ONLY the three settings columns for the cut-table config. Inspector-
guarded so a re-run is a no-op (see CLAUDE.md migration convention).
server_default backfills the existing singleton settings row (id=1) since the
columns are NOT NULL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b53ee8ea1c0d'
down_revision: Union[str, Sequence[str], None] = 'e6a2c9b4d8f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("settings")}
    with op.batch_alter_table("settings", schema=None) as batch_op:
        if "cut_calorie_limit" not in cols:
            batch_op.add_column(sa.Column(
                "cut_calorie_limit", sa.Integer(), nullable=False, server_default="2100",
            ))
        if "cut_protein_limit" not in cols:
            batch_op.add_column(sa.Column(
                "cut_protein_limit", sa.Integer(), nullable=False, server_default="170",
            ))
        if "cut_start_date" not in cols:
            batch_op.add_column(sa.Column("cut_start_date", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("settings", schema=None) as batch_op:
        batch_op.drop_column("cut_start_date")
        batch_op.drop_column("cut_protein_limit")
        batch_op.drop_column("cut_calorie_limit")
