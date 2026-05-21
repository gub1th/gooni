"""add optional icon column to notes

Notion-style per-note icon. Single emoji OR a "lucide:<name>" reference
(same encoding Space.emoji uses). Nullable; Gooni's default = no icon.

Inspector-guarded per project convention so re-runs are no-ops.

Revision ID: a3f9e1c5b2d8
Revises: b49c74cbe9ff
Create Date: 2026-05-21
"""

from alembic import op
import sqlalchemy as sa


revision = "a3f9e1c5b2d8"
down_revision = "b49c74cbe9ff"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("notes")}
    if "icon" in cols:
        return
    op.add_column("notes", sa.Column("icon", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("notes", "icon")
