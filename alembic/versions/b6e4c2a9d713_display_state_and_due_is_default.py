"""display state blob + reminders.due_is_default

Revision ID: b6e4c2a9d713
Revises: a3d1f0c9e5b7
Create Date: 2026-07-29

Two additive columns for the ambient-dash rebuild.

1. settings.display (nullable Text) — the persistent kiosk's desired state,
   same Text-not-JSON convention as settings.focus_cam so the shape can grow
   without another migration:

     {"desired": "deep_rest"|"rest"|"awake"|"dash",
      "at": iso8601|null, "source": str|null}

   NULL default; callers treat missing as {"desired": "rest"}.

2. reminders.due_is_default (Boolean, NOT NULL, default False) — marks a due
   date NOBODY chose. Every new reminder/promise now gets one (defaulted to
   today's local EOD) so the dashboard can split short-term from longer-term on
   due distance. The flag is what stops `auto_break_overdue` from marking you
   broken at midnight on a deadline Gooni invented.

   BACKFILL NOTE: existing rows get False, which is correct. A pre-rebuild row
   with a due_at got that date from Daniel or from a parsed hint — explicit
   either way — so it stays eligible to auto-break, exactly as it was before
   this migration. Undated legacy rows keep due_at NULL and never auto-break
   (unchanged). So nothing about existing data changes behavior.

Idempotent: inspector guards so re-runs / half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "b6e4c2a9d713"
down_revision = "a3d1f0c9e5b7"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)

    settings_cols = [c["name"] for c in insp.get_columns("settings")]
    if "display" not in settings_cols:
        # SQLite ADD COLUMN is native + rebuild-free for a nullable column.
        op.add_column("settings", sa.Column("display", sa.Text(), nullable=True))

    reminder_cols = [c["name"] for c in insp.get_columns("reminders")]
    if "due_is_default" not in reminder_cols:
        # NOT NULL needs a server_default so the ADD COLUMN can fill existing
        # rows in one pass (SQLite can't add a NOT NULL column without one).
        op.add_column(
            "reminders",
            sa.Column(
                "due_is_default",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade():
    op.drop_column("reminders", "due_is_default")
    op.drop_column("settings", "display")
