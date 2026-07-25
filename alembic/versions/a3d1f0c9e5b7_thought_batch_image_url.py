"""thought_batch image_url — pinned image cards on the arcs canvas

A photo uploaded in a Claude conversation can't cross to Gooni through the
model (tool-call args are text; the model has no handle to the upload's
bytes). The code-execution sandbox CAN read the bytes AND has network egress,
so it POSTs the image to /focus/cards/image → R2 → a batch card carrying this
url. One nullable column, no data migration.

Revision ID: a3d1f0c9e5b7
Revises: b7e2f9a1c4d6
Create Date: 2026-07-24
"""

from alembic import op
import sqlalchemy as sa


revision = "a3d1f0c9e5b7"
down_revision = "b7e2f9a1c4d6"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns(table)]
    return column in cols


def upgrade() -> None:
    # Inspector guard — re-runs (half-applied recovery) are no-ops.
    if not _has_column("thought_batches", "image_url"):
        op.add_column("thought_batches", sa.Column("image_url", sa.Text(), nullable=True))


def downgrade() -> None:
    if _has_column("thought_batches", "image_url"):
        op.drop_column("thought_batches", "image_url")
