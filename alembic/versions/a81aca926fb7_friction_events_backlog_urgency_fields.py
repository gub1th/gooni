"""friction_events + backlog urgency fields

Revision ID: a81aca926fb7
Revises: 216b9252fe51
Create Date: 2026-05-19 06:50:00.000000

G2 (self-PM backlog reasoning): adds the friction_events log table and
three columns on backlog_tickets for urgency aggregation. Hand-written
inspector-guarded — skip autogen drift like in 216b9252fe51.

friction_events ties each "Gooni hit a wall" moment to a BacklogTicket
so the same gap aggregates across sessions instead of stacking dups.
backlog_tickets.urgency_score = sum(friction × blast_radius × recency)
recomputed nightly + bumped synchronously when fresh events fire.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a81aca926fb7'
down_revision: Union[str, Sequence[str], None] = ('216b9252fe51', 'a8f3c2e1d9b4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(bind, table: str) -> bool:
    return sa.inspect(bind).has_table(table)


def _has_column(bind, table: str, column: str) -> bool:
    if not _has_table(bind, table):
        return False
    return any(c["name"] == column for c in sa.inspect(bind).get_columns(table))


def _has_index(bind, table: str, index: str) -> bool:
    if not _has_table(bind, table):
        return False
    return any(idx["name"] == index for idx in sa.inspect(bind).get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()

    # backlog_tickets gains three columns. Each guarded so re-runs noop.
    if _has_table(bind, "backlog_tickets"):
        if not _has_column(bind, "backlog_tickets", "blast_radius"):
            with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
                batch_op.add_column(sa.Column("blast_radius", sa.Integer(), nullable=True))
        if not _has_column(bind, "backlog_tickets", "urgency_score"):
            with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
                batch_op.add_column(sa.Column("urgency_score", sa.Float(), nullable=True))
        if not _has_index(bind, "backlog_tickets", "ix_backlog_tickets_urgency_score"):
            with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
                batch_op.create_index(
                    batch_op.f("ix_backlog_tickets_urgency_score"),
                    ["urgency_score"], unique=False,
                )
        if not _has_column(bind, "backlog_tickets", "last_friction_at"):
            with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
                batch_op.add_column(sa.Column("last_friction_at", sa.DateTime(), nullable=True))
        if not _has_index(bind, "backlog_tickets", "ix_backlog_tickets_last_friction_at"):
            with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
                batch_op.create_index(
                    batch_op.f("ix_backlog_tickets_last_friction_at"),
                    ["last_friction_at"], unique=False,
                )

    # friction_events table — only create if backlog_tickets exists (FK).
    if _has_table(bind, "backlog_tickets") and not _has_table(bind, "friction_events"):
        op.create_table(
            "friction_events",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("backlog_ticket_id", sa.Integer(), nullable=False),
            sa.Column("message_id", sa.Integer(), nullable=True),
            sa.Column("blast_radius", sa.Integer(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column(
                "source", sa.String(), nullable=False, server_default="user_utterance"
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["backlog_ticket_id"], ["backlog_tickets.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["message_id"], ["messages.id"], ondelete="SET NULL"
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("friction_events", schema=None) as batch_op:
            batch_op.create_index(
                batch_op.f("ix_friction_events_backlog_ticket_id"),
                ["backlog_ticket_id"], unique=False,
            )
            batch_op.create_index(
                batch_op.f("ix_friction_events_message_id"),
                ["message_id"], unique=False,
            )
            batch_op.create_index(
                batch_op.f("ix_friction_events_created_at"),
                ["created_at"], unique=False,
            )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "friction_events"):
        with op.batch_alter_table("friction_events", schema=None) as batch_op:
            batch_op.drop_index(batch_op.f("ix_friction_events_created_at"))
            batch_op.drop_index(batch_op.f("ix_friction_events_message_id"))
            batch_op.drop_index(batch_op.f("ix_friction_events_backlog_ticket_id"))
        op.drop_table("friction_events")

    if _has_index(bind, "backlog_tickets", "ix_backlog_tickets_last_friction_at"):
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.drop_index(batch_op.f("ix_backlog_tickets_last_friction_at"))
    if _has_column(bind, "backlog_tickets", "last_friction_at"):
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.drop_column("last_friction_at")
    if _has_index(bind, "backlog_tickets", "ix_backlog_tickets_urgency_score"):
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.drop_index(batch_op.f("ix_backlog_tickets_urgency_score"))
    if _has_column(bind, "backlog_tickets", "urgency_score"):
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.drop_column("urgency_score")
    if _has_column(bind, "backlog_tickets", "blast_radius"):
        with op.batch_alter_table("backlog_tickets", schema=None) as batch_op:
            batch_op.drop_column("blast_radius")
