"""session screen frames + summary

Revision ID: 8a75d884af3d
Revises: 7f3a1c9e04b2
Create Date: 2026-09-09 12:37:00

Hand-trimmed from autogenerate: the autogen also proposed dropping a dozen
unrelated legacy/FTS tables that predate this migration and are not in the
model (goals, suggestions, workouts, *_fts_*, legacy backups, …). Those drops
are noise from the model/DB drift, not this change, and are deliberately left
out — this revision adds ONE table and THREE columns and nothing else.

Inspector-guarded so a re-run is a no-op (the half-applied-state recovery
convention), and additive-only so downgrade is clean.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "8a75d884af3d"
down_revision: Union[str, Sequence[str], None] = "7f3a1c9e04b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(bind, name: str) -> bool:
    return name in inspect(bind).get_table_names()


def _has_column(bind, table: str, col: str) -> bool:
    return col in {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "session_screen_frames"):
        op.create_table(
            "session_screen_frames",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("session_id", sa.Integer(), nullable=False),
            sa.Column("ts", sa.DateTime(), nullable=False),
            sa.Column("app", sa.String(), nullable=True),
            sa.Column("window_name", sa.Text(), nullable=True),
            sa.Column("url", sa.Text(), nullable=True),
            sa.Column("title", sa.Text(), nullable=True),
            sa.Column("text", sa.Text(), nullable=True),
            sa.Column("r2_key", sa.String(), nullable=True),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("session_screen_frames", schema=None) as b:
            b.create_index(b.f("ix_session_screen_frames_id"), ["id"], unique=False)
            b.create_index(b.f("ix_session_screen_frames_session_id"), ["session_id"], unique=False)
            b.create_index(b.f("ix_session_screen_frames_ts"), ["ts"], unique=False)
            b.create_index(b.f("ix_session_screen_frames_created_at"), ["created_at"], unique=False)
            b.create_index(b.f("ix_session_screen_frames_client_id"), ["client_id"], unique=True)

    for col, coltype in (
        ("screen_summary", sa.Text()),
        ("on_task_pct", sa.Integer()),
        ("summary_at", sa.DateTime()),
    ):
        if not _has_column(bind, "focus_sessions", col):
            op.add_column("focus_sessions", sa.Column(col, coltype, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()

    for col in ("summary_at", "on_task_pct", "screen_summary"):
        if _has_column(bind, "focus_sessions", col):
            op.drop_column("focus_sessions", col)

    if _has_table(bind, "session_screen_frames"):
        op.drop_table("session_screen_frames")
