"""add reactions table

Confluence-style emoji reactions on notes + comments. Polymorphic via
(target_type, target_id) so we don't need a per-target join table. UNIQUE
on (target_type, target_id, emoji, reactor_id) prevents one reactor
double-reacting with the same emoji on the same target.

reactor_id is an opaque string (anonymous localStorage UUID today, real
user id once auth lands). Not a foreign key — backend doesn't care who
they are, only that they're consistent.

Inspector-guarded per CLAUDE.md migration convention so re-runs are
no-ops if the table already landed via a parallel boot.

Revision ID: b9f1c4a2e8d3
Revises: a843ba2b74a7
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa


revision = "b9f1c4a2e8d3"
down_revision = "a843ba2b74a7"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("reactions"):
        return
    op.create_table(
        "reactions",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("target_type", sa.String, nullable=False),
        sa.Column("target_id", sa.Integer, nullable=False),
        sa.Column("emoji", sa.String, nullable=False),
        sa.Column("reactor_id", sa.String, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "target_type", "target_id", "emoji", "reactor_id",
            name="uq_reaction_target_emoji_reactor",
        ),
    )
    op.create_index(
        "ix_reactions_target",
        "reactions",
        ["target_type", "target_id"],
    )


def downgrade():
    op.drop_index("ix_reactions_target", table_name="reactions")
    op.drop_table("reactions")
