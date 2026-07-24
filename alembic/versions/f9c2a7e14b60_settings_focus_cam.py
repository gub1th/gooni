"""settings.focus_cam — control+state blob for the webcam focus sidecar

Revision ID: f9c2a7e14b60
Revises: 1aee2da7e158
Create Date: 2026-07-24

Adds Settings.focus_cam (nullable Text). Holds a JSON blob (Text, not a JSON
column, so the shape can grow without future migrations — same convention as
overlay_whoop_keys / Note.home_pos):

  {"control": "idle"|"running",
   "state": "focused"|"distracted"|"away"|"paused"|null,
   "score": float|null, "app": str|null,
   "session_id": str|null, "at": iso8601|null}

NULL default; callers treat missing as {"control":"idle"}. Idempotent:
inspector guard so re-runs / half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "f9c2a7e14b60"
down_revision = "1aee2da7e158"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("settings")]
    if "focus_cam" not in cols:
        # SQLite ADD COLUMN is native + rebuild-free for a nullable column.
        op.add_column("settings", sa.Column("focus_cam", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("settings", "focus_cam")
