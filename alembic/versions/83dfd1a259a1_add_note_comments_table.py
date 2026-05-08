"""add note_comments table

Confluence-style flat comment thread under each note. Triggered by the
mcp__gooni__add_comment / POST /notes/{id}/comments path.

Autogen produced a giant diff of unrelated drift (legacy table cleanup,
INTEGER→Boolean cosmetic type changes); all of that was stripped per the
same lesson from PR #144 — only ship migrations that match the intent.

Revision ID: 83dfd1a259a1
Revises: b2c3d4e5f6a7
Create Date: 2026-05-07 22:29:39
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '83dfd1a259a1'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    return bool(
        bind.execute(
            sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": name},
        ).first()
    )


def upgrade() -> None:
    if _has_table("note_comments"):
        return
    op.create_table(
        "note_comments",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column(
            "note_id",
            sa.Integer(),
            sa.ForeignKey("notes.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("author", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    if _has_table("note_comments"):
        op.drop_table("note_comments")
