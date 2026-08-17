"""focus_sessions — the focus session lifecycle, server-side

Revision ID: a7f31c9d5e02
Revises: d9f2a4c71b83
Create Date: 2026-08-16

The session moves out of the browser. Until now it lived only in
`frontend/src/stores/useFocusSessionStore.ts` (localStorage), which meant no
other client could start, stop or even SEE one — Claude could not run a session,
the sidecar only ever learned a reconcile flag, and a machine that slept came
back to a clock that had kept counting.

One table, and deliberately no second source of truth for the minutes: stopping
a session still writes the same `focus` TrackableEntry per LOCAL day that the
client used to write, in the same `value_json` shape `focus_attribution` already
reads. This table owns the LIFECYCLE; the entry stays the durable record.

Idempotent: inspector guards so re-runs / half-applied states are no-ops (the
convention every migration here follows, since `_alembic_upgrade()` runs at
uvicorn boot).
"""
from alembic import op
import sqlalchemy as sa


revision = "a7f31c9d5e02"
down_revision = "d9f2a4c71b83"
branch_labels = None
depends_on = None

_TABLE = "focus_sessions"


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if _TABLE in insp.get_table_names():
        return

    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        # No cascade: a deleted promise leaves the session standing, the same
        # way focus_attribution reports `promise_exists: false` rather than
        # dropping the row and quietly shrinking the day's total.
        sa.Column(
            "promise_id",
            sa.Integer(),
            sa.ForeignKey("promises.id"),
            nullable=True,
        ),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, server_default="running"),
        # Naive UTC throughout, like every other datetime in this schema.
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("run_started_at", sa.DateTime(), nullable=True),
        sa.Column("paused_at", sa.DateTime(), nullable=True),
        sa.Column("total_paused_ms", sa.Integer(), nullable=False, server_default="0"),
        # JSON list of closed focus runs — Text so the shape grows without
        # another migration (the Settings.focus_cam convention).
        sa.Column("segments", sa.Text(), nullable=True),
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("style", sa.String(), nullable=False, server_default="stopwatch"),
        sa.Column("target_ms", sa.Integer(), nullable=True),
        sa.Column("kept", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        f"ix_{_TABLE}_promise_id", _TABLE, ["promise_id"], if_not_exists=True
    )
    # `active()` reads by state on every poll — the one hot path here.
    op.create_index(f"ix_{_TABLE}_state", _TABLE, ["state"], if_not_exists=True)
    op.create_index(
        f"ix_{_TABLE}_started_at", _TABLE, ["started_at"], if_not_exists=True
    )
    op.create_index(
        f"ix_{_TABLE}_created_at", _TABLE, ["created_at"], if_not_exists=True
    )


def downgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if _TABLE not in insp.get_table_names():
        return
    # The written TrackableEntry rows are NOT touched: they are the durable
    # record of the minutes and predate this table's existence as a concept.
    # Rolling back the lifecycle must not delete the log.
    op.drop_table(_TABLE)
