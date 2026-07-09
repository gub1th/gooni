"""messages: has_actionable_signal + signal_preview (glow)

Ambient-loop v2 Slice 3 — log-first capture. The extractor's promise-
create verdict lands as an annotation on the Message instead of an
auto-created Promise; Daniel promotes from the log's glow dot.

Revision ID: b7d4e9f2c1a5
Revises: f3b8d1c6a9e2
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "b7d4e9f2c1a5"
down_revision = "f3b8d1c6a9e2"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("messages")}
    if "has_actionable_signal" not in cols:
        op.add_column(
            "messages",
            sa.Column(
                "has_actionable_signal",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            ),
        )
    if "signal_preview" not in cols:
        op.add_column("messages", sa.Column("signal_preview", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("messages", "signal_preview")
    op.drop_column("messages", "has_actionable_signal")
