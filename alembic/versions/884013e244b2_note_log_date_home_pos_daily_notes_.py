"""note log_date + home_pos (daily notes + stickies)

Adds two nullable columns to `notes`:
  - log_date : the day a per-day "daily log" note is about (matrix note
    column). Indexed so a date-range pull is cheap. Null = ordinary note.
  - home_pos : JSON-as-text {"x","y"} viewport fractions for a sticky note
    parked on the ambient home canvas. Null = not a sticky.

No data migration — the old note-trackable held zero json rows, so daily
notes start fresh. Inspector-guarded so re-runs (half-applied boots) are
no-ops.

Revision ID: 884013e244b2
Revises: 4d9c44f8f546
Create Date: 2026-07-11 02:21:55.358446

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '884013e244b2'
down_revision: Union[str, Sequence[str], None] = '4d9c44f8f546'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _note_cols() -> set[str]:
    insp = sa.inspect(op.get_bind())
    return {c["name"] for c in insp.get_columns("notes")}


def _note_indexes() -> set[str]:
    insp = sa.inspect(op.get_bind())
    return {ix["name"] for ix in insp.get_indexes("notes")}


def upgrade() -> None:
    cols = _note_cols()
    with op.batch_alter_table("notes", schema=None) as batch_op:
        if "log_date" not in cols:
            batch_op.add_column(sa.Column("log_date", sa.Date(), nullable=True))
        if "home_pos" not in cols:
            batch_op.add_column(sa.Column("home_pos", sa.Text(), nullable=True))
    if "ix_notes_log_date" not in _note_indexes():
        op.create_index(
            "ix_notes_log_date", "notes", ["log_date"], unique=False, if_not_exists=True
        )


def downgrade() -> None:
    if "ix_notes_log_date" in _note_indexes():
        op.drop_index("ix_notes_log_date", table_name="notes")
    cols = _note_cols()
    with op.batch_alter_table("notes", schema=None) as batch_op:
        if "home_pos" in cols:
            batch_op.drop_column("home_pos")
        if "log_date" in cols:
            batch_op.drop_column("log_date")
