"""add notes column to backlog_tickets

Revision ID: d2350b76ef42
Revises: a4b54b286abd
Create Date: 2026-05-15 18:47:45.401468

Free-form ticket body for richer context — design notes, PR pointers,
follow-up scratch. Subtitle stays as the one-line tagline; notes is
the multi-line story.

Idempotent: if a parallel prod box already has the column (manual prep
or rerun), skip the add instead of crashing the boot. Same pattern as
the wa_processed_ids / habits migrations.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd2350b76ef42'
down_revision: Union[str, Sequence[str], None] = 'a4b54b286abd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("backlog_tickets")}
    if "notes" not in cols:
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.add_column(sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
        batch_op.drop_column("notes")
