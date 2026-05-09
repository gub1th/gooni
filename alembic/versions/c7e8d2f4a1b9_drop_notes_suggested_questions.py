"""drop notes.suggested_questions (dead column)

The `notes.suggested_questions` column cached output from a half-built
"probing questions a sharp friend would ask" feature. Backend endpoint
`POST /notes/{note_id}/suggest-questions` existed but no frontend ever
called it; column wrote ~hashed JSON blobs every time the endpoint
fired, otherwise sat unused. Endpoint + column both removed in the same
PR — this migration drops the column.

PRAGMA-guarded so re-running on an already-migrated DB is a no-op
(matches the pattern from a1b2c3d4e5f6).

Revision ID: c7e8d2f4a1b9
Revises: 83dfd1a259a1
Create Date: 2026-05-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c7e8d2f4a1b9'
down_revision: Union[str, Sequence[str], None] = '83dfd1a259a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, col: str) -> bool:
    bind = op.get_bind()
    return any(r[1] == col for r in bind.execute(sa.text(f"PRAGMA table_info({table})")))


def upgrade() -> None:
    if _has_column("notes", "suggested_questions"):
        with op.batch_alter_table("notes") as batch:
            batch.drop_column("suggested_questions")


def downgrade() -> None:
    if not _has_column("notes", "suggested_questions"):
        with op.batch_alter_table("notes") as batch:
            batch.add_column(sa.Column("suggested_questions", sa.Text(), nullable=True))
