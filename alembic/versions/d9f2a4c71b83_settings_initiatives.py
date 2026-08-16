"""settings.initiatives — cached snapshot for the initiative synthesizer

Revision ID: d9f2a4c71b83
Revises: c3e7b91d5a24
Create Date: 2026-08-16

Adds Settings.initiatives (nullable Text). Holds one JSON snapshot of what
Daniel is currently working on, clustered out of memories + thought-batches +
active promises by services/initiative_service and refreshed once a day:

  {"version": 1, "built_at": iso8601, "item_count": int,
   "clusters": [{"label": str, "size": int, "summary": str,
                 "by_type": {...}, "items": [{"type","id","text"}],
                 "representative_embedding": [float]}],
   "uncategorized": {"count": int, "items": [...]},
   "total_clusters": int, "truncated": bool}

Text-not-JSON so the shape can grow without another migration — the same
convention as focus_cam / display / overlay_whoop_keys. NULL default; readers
treat missing as "never synthesized" and render zero initiatives (not an
error). Idempotent: inspector guard so re-runs / half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "d9f2a4c71b83"
down_revision = "c3e7b91d5a24"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("settings")]
    if "initiatives" not in cols:
        # SQLite ADD COLUMN is native + rebuild-free for a nullable column.
        op.add_column("settings", sa.Column("initiatives", sa.Text(), nullable=True))


def downgrade():
    # Dropping the cache loses nothing durable — the next refresh rebuilds it
    # from the memories/notes/promises it was derived from.
    op.drop_column("settings", "initiatives")
