"""promise needs_clarification col (G3.1)

Revision ID: a843ba2b74a7
Revises: 43a0649e9e06
Create Date: 2026-05-20 01:51:58.706235

Adds `Promise.needs_clarification` (BOOLEAN DEFAULT FALSE). Replaces the
old `proposed` state as the signal for "this promise is vague — Gooni
should push back conversationally." No longer a state-machine gate; just
metadata that drives ack composition + future digest analytics.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a843ba2b74a7'
down_revision: Union[str, Sequence[str], None] = '43a0649e9e06'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _promise_cols(bind):
    return {c["name"] for c in sa.inspect(bind).get_columns("promises")}


def upgrade() -> None:
    bind = op.get_bind()
    cols = _promise_cols(bind)
    if "needs_clarification" not in cols:
        with op.batch_alter_table("promises", schema=None) as batch_op:
            batch_op.add_column(
                sa.Column(
                    "needs_clarification",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.text("0"),
                )
            )


def downgrade() -> None:
    bind = op.get_bind()
    cols = _promise_cols(bind)
    if "needs_clarification" in cols:
        with op.batch_alter_table("promises", schema=None) as batch_op:
            batch_op.drop_column("needs_clarification")
