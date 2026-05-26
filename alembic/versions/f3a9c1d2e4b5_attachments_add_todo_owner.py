"""attachments: add todo_id owner + make note_id nullable

Revision ID: f3a9c1d2e4b5
Revises: b53ee8ea1c0d
Create Date: 2026-05-26

Lets an Attachment belong to a Todo (todo_id) as well as a Note. note_id
becomes nullable since a todo-owned row leaves it NULL. Inspector-guarded
add so a re-run is a no-op (see CLAUDE.md migration convention). SQLite needs
batch mode to drop NOT NULL (it rebuilds the table). FK on todo_id omitted in
DDL — SQLite doesn't enforce it; the model declares it for the ORM.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a9c1d2e4b5'
down_revision: Union[str, Sequence[str], None] = 'b53ee8ea1c0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("attachments")}
    idx = {i["name"] for i in insp.get_indexes("attachments")}
    with op.batch_alter_table("attachments", schema=None) as batch_op:
        if "todo_id" not in cols:
            batch_op.add_column(sa.Column("todo_id", sa.Integer(), nullable=True))
        # note_id was NOT NULL in the note-only era; todo-owned rows leave it
        # NULL, so relax the constraint (batch = table rebuild on SQLite).
        batch_op.alter_column("note_id", existing_type=sa.Integer(), nullable=True)
    if "ix_attachments_todo_id" not in idx:
        op.create_index("ix_attachments_todo_id", "attachments", ["todo_id"])


def downgrade() -> None:
    op.drop_index("ix_attachments_todo_id", table_name="attachments")
    with op.batch_alter_table("attachments", schema=None) as batch_op:
        batch_op.alter_column("note_id", existing_type=sa.Integer(), nullable=False)
        batch_op.drop_column("todo_id")
