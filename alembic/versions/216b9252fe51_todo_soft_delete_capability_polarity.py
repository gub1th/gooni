"""todo soft delete + capability polarity

Revision ID: 216b9252fe51
Revises: fd1ad0565930
Create Date: 2026-05-18 23:33:46.635013

G1 (groom mutation surface): adds Todo.deleted_at for 24h-undo soft-delete
and CapabilityFacet.polarity so negative facets ('I cannot:') render
alongside positive ('I can:'). Inspector-guarded so re-runs are no-ops.

Autogen produced ~500 lines of unrelated drift (legacy-table drops, type
churn on notes/messages, server_default flips). All cosmetic SQLite
drift per project convention; not part of G1 scope. Migration trimmed
to the two actual additions.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '216b9252fe51'
down_revision: Union[str, Sequence[str], None] = 'fd1ad0565930'
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

    # Todo.deleted_at — soft-delete tombstone. NULL = live; NOT NULL =
    # deleted at that time. Read paths in todo_service filter
    # `deleted_at IS NULL`. Lifespan sweeper hard-purges past 24h.
    if _has_table(bind, "todos"):
        if not _has_column(bind, "todos", "deleted_at"):
            with op.batch_alter_table("todos", schema=None) as batch_op:
                batch_op.add_column(sa.Column("deleted_at", sa.DateTime(), nullable=True))
        if not _has_index(bind, "todos", "ix_todos_deleted_at"):
            with op.batch_alter_table("todos", schema=None) as batch_op:
                batch_op.create_index(
                    batch_op.f("ix_todos_deleted_at"), ["deleted_at"], unique=False
                )

    # CapabilityFacet.polarity — 'positive' | 'negative'. Positive facets
    # render under "I can:" / "I tend to:" / "I am:" by layer. Negative
    # facets render under "I cannot:". Load-bearing for capability
    # honesty so LLM stops claiming abilities it lacks. Skip gracefully
    # if the table doesn't exist on this DB yet — prod has it; some local
    # dev DBs are mid-baseline and never picked it up.
    if _has_table(bind, "capability_facets"):
        if not _has_column(bind, "capability_facets", "polarity"):
            with op.batch_alter_table("capability_facets", schema=None) as batch_op:
                batch_op.add_column(
                    sa.Column(
                        "polarity",
                        sa.String(),
                        nullable=False,
                        server_default="positive",
                    )
                )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "capability_facets", "polarity"):
        with op.batch_alter_table("capability_facets", schema=None) as batch_op:
            batch_op.drop_column("polarity")

    if _has_index(bind, "todos", "ix_todos_deleted_at"):
        with op.batch_alter_table("todos", schema=None) as batch_op:
            batch_op.drop_index(batch_op.f("ix_todos_deleted_at"))
    if _has_column(bind, "todos", "deleted_at"):
        with op.batch_alter_table("todos", schema=None) as batch_op:
            batch_op.drop_column("deleted_at")
