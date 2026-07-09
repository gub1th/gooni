"""settings: overlay anchor note + whoop-select keys

Ambient-loop v2 Slice 4 — the hover overlay's two user-picked knobs.

Revision ID: c9e2f7a4b8d1
Revises: b7d4e9f2c1a5
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c9e2f7a4b8d1"
down_revision = "b7d4e9f2c1a5"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("settings")}
    if "overlay_anchor_note_id" not in cols:
        op.add_column(
            "settings",
            sa.Column("overlay_anchor_note_id", sa.Integer(), nullable=True),
        )
    if "overlay_whoop_keys" not in cols:
        op.add_column(
            "settings",
            sa.Column(
                "overlay_whoop_keys",
                sa.Text(),
                nullable=False,
                server_default="[]",
            ),
        )


def downgrade():
    op.drop_column("settings", "overlay_whoop_keys")
    op.drop_column("settings", "overlay_anchor_note_id")
