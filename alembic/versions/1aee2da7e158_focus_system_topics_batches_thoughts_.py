"""focus system: topics, batches, thoughts, people, mentions, reminders

Revision ID: 1aee2da7e158
Revises: c7e9a1f4b2d8
Create Date: 2026-07-23 02:50:16.657934

PRD: gooni-focus-system-plan.md. Additive — six NEW tables alongside the
ambient-loop v2 primitives, nothing existing touched.

Hand-trimmed from autogenerate: the raw output also wanted to drop the
runtime-created FTS5 virtual tables (memories_fts*/notes_fts*) and rewrite
server_default cosmetics on a dozen unrelated columns. All of that is
pre-existing drift from earlier migrations that declared python-side defaults
without server_default — NOT part of this change. Stripped. Only the six focus
tables remain. Inspector guards make re-runs no-ops (boot-time upgrade +
half-applied-state recovery per CLAUDE.md).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1aee2da7e158"
down_revision: Union[str, Sequence[str], None] = "c7e9a1f4b2d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(name)


def upgrade() -> None:
    if not _has_table("topics"):
        op.create_table(
            "topics",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("parent_id", sa.Integer(), nullable=True),
            sa.Column("salience", sa.Float(), nullable=False),
            sa.Column("last_touched", sa.DateTime(), nullable=False),
            sa.Column("color", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["parent_id"], ["topics.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_topics_id", "topics", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_topics_name", "topics", ["name"], unique=False, if_not_exists=True)
        op.create_index("ix_topics_parent_id", "topics", ["parent_id"], unique=False, if_not_exists=True)

    if not _has_table("focus_people"):
        op.create_table(
            "focus_people",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("context", sa.Text(), nullable=True),
            sa.Column("first_seen", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_focus_people_id", "focus_people", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_focus_people_name", "focus_people", ["name"], unique=False, if_not_exists=True)

    if not _has_table("thought_batches"):
        op.create_table(
            "thought_batches",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("topic_id", sa.Integer(), nullable=False),
            sa.Column("label", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("ended_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["topic_id"], ["topics.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_thought_batches_ended_at", "thought_batches", ["ended_at"], unique=False, if_not_exists=True)
        op.create_index("ix_thought_batches_id", "thought_batches", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_thought_batches_topic_id", "thought_batches", ["topic_id"], unique=False, if_not_exists=True)

    if not _has_table("thoughts"):
        op.create_table(
            "thoughts",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("timestamp", sa.DateTime(), nullable=False),
            sa.Column("batch_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["batch_id"], ["thought_batches.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_thoughts_batch_id", "thoughts", ["batch_id"], unique=False, if_not_exists=True)
        op.create_index("ix_thoughts_id", "thoughts", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_thoughts_timestamp", "thoughts", ["timestamp"], unique=False, if_not_exists=True)

    if not _has_table("mentions"):
        op.create_table(
            "mentions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("thought_id", sa.Integer(), nullable=False),
            sa.Column("person_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["person_id"], ["focus_people.id"]),
            sa.ForeignKeyConstraint(["thought_id"], ["thoughts.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("thought_id", "person_id", name="uq_mention_thought_person"),
        )
        op.create_index("ix_mentions_id", "mentions", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_mentions_person_id", "mentions", ["person_id"], unique=False, if_not_exists=True)
        op.create_index("ix_mentions_thought_id", "mentions", ["thought_id"], unique=False, if_not_exists=True)

    if not _has_table("reminders"):
        op.create_table(
            "reminders",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("content", sa.String(), nullable=False),
            sa.Column("owed_to", sa.Integer(), nullable=True),
            sa.Column("due_at", sa.DateTime(), nullable=True),
            sa.Column("done", sa.Boolean(), nullable=False),
            sa.Column("thought_id", sa.Integer(), nullable=True),
            sa.Column("parent_id", sa.Integer(), nullable=True),
            sa.Column("attachment_path", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["owed_to"], ["focus_people.id"]),
            sa.ForeignKeyConstraint(["parent_id"], ["reminders.id"]),
            sa.ForeignKeyConstraint(["thought_id"], ["thoughts.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_reminders_created_at", "reminders", ["created_at"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_done", "reminders", ["done"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_due_at", "reminders", ["due_at"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_id", "reminders", ["id"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_owed_to", "reminders", ["owed_to"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_parent_id", "reminders", ["parent_id"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_thought_id", "reminders", ["thought_id"], unique=False, if_not_exists=True)
        op.create_index("ix_reminders_type", "reminders", ["type"], unique=False, if_not_exists=True)


def downgrade() -> None:
    # Child-first so FKs don't block the drops.
    for tbl in ("reminders", "mentions", "thoughts", "thought_batches", "focus_people", "topics"):
        if _has_table(tbl):
            op.drop_table(tbl)
