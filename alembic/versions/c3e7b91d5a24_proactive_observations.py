"""proactive_observations + settings.proactive_enabled

Revision ID: c3e7b91d5a24
Revises: a5c81f30d7e2
Create Date: 2026-08-15

The background proactive loop's store. One row per thing Gooni decided was
worth saying while nobody was talking to it; `GET /proactive/current` serves the
newest live `channel="ambient"` one to the ambient home, and a
`channel="whatsapp"` row records a silence-triggered reach-out that Meta already
accepted (which is what the once-per-day rule reads). See
ProactiveObservation's docstring in app/db/models.py for why this is a table
rather than a module-level dict (Fly restarts, durable dismissal, the
once-per-day marker, and the tuning read).

`settings.proactive_enabled` is the runtime kill switch. It lands DEFAULTED ON
(server_default 1) so the loop is live the moment this deploys — a proactive
layer nobody switches on is never evaluated. The env var
GOONI_PROACTIVE_DISABLED still wins over it, so stopping prod never needs a
database write.

Additive: one new table, one new column. Nothing existing is read differently.
Idempotent — inspector guards + if_not_exists on indexes, so re-runs and
half-applied states are no-ops.
"""
from alembic import op
import sqlalchemy as sa


revision = "c3e7b91d5a24"
down_revision = "a5c81f30d7e2"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("proactive_observations"):
        op.create_table(
            "proactive_observations",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column(
                "channel", sa.String(), nullable=False, server_default="ambient"
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column(
                "dismissed", sa.Boolean(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column("dismissed_at", sa.DateTime(), nullable=True),
            sa.Column("context_digest", sa.Text(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
        )

    op.create_index(
        "ix_proactive_observations_id",
        "proactive_observations",
        ["id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_proactive_observations_created_at",
        "proactive_observations",
        ["created_at"],
        if_not_exists=True,
    )
    # The serve read is `expires_at > now AND NOT dismissed`, newest first.
    op.create_index(
        "ix_proactive_observations_expires_at",
        "proactive_observations",
        ["expires_at"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_proactive_observations_dismissed",
        "proactive_observations",
        ["dismissed"],
        if_not_exists=True,
    )
    # The once-per-day reach-out read: this channel, this local day.
    op.create_index(
        "ix_proactive_observations_channel",
        "proactive_observations",
        ["channel"],
        if_not_exists=True,
    )

    cols = {c["name"] for c in insp.get_columns("settings")}
    if "proactive_enabled" not in cols:
        op.add_column(
            "settings",
            sa.Column(
                "proactive_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("1"),
            ),
        )


def downgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)

    cols = {c["name"] for c in insp.get_columns("settings")}
    if "proactive_enabled" in cols:
        with op.batch_alter_table("settings") as batch:
            batch.drop_column("proactive_enabled")

    if insp.has_table("proactive_observations"):
        op.drop_table("proactive_observations")
