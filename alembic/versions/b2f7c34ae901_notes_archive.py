"""notes.is_archived + notes.archived_at — the non-destructive hide

Revision ID: b2f7c34ae901
Revises: a7f31c9d5e02
Create Date: 2026-08-21

Until now DELETE was the only way to make a note stop showing up, which is a
destructive answer to a non-destructive question. `is_archived` is the sibling
of `is_draft`: one boolean on the row, honoured by every listing read, with the
note itself (content, tags, pins, embedding, attachments, children) untouched.

`archived_at` rides along because a list of archived notes immediately raises
"when did I put this away" — and it is the only honest sort key for that list,
since `updated_at` is the last EDIT, typically long before the archiving.

Backfill: every existing row gets FALSE, never null. `server_default="0"` makes
the ALTER itself fill existing rows (SQLite rewrites the table with the default
in place); the explicit UPDATE afterwards is the belt-and-braces for a backend
where an added column could land NULL. `archived_at` stays nullable — null IS
the correct value for a note that was never archived.

Idempotent: inspector guards so re-runs / half-applied states are no-ops (the
convention every migration here follows, since `_alembic_upgrade()` runs at
uvicorn boot).
"""
from alembic import op
import sqlalchemy as sa


revision = "b2f7c34ae901"
down_revision = "a7f31c9d5e02"
branch_labels = None
depends_on = None

_TABLE = "notes"


def _columns(bind) -> set[str]:
    insp = sa.inspect(bind)
    if _TABLE not in insp.get_table_names():
        return set()
    return {c["name"] for c in insp.get_columns(_TABLE)}


def upgrade():
    bind = op.get_bind()
    cols = _columns(bind)
    if not cols:
        return

    if "is_archived" not in cols:
        op.add_column(
            _TABLE,
            sa.Column(
                "is_archived",
                sa.Boolean(),
                nullable=False,
                server_default="0",
            ),
        )
        # Existing rows must read FALSE, never NULL — every listing read
        # filters on this column and a NULL would silently drop the row from
        # `is_archived == False` under SQL three-valued logic (NULL = 0 is
        # NULL, not true), i.e. archiving the whole corpus by omission.
        op.execute(sa.text("UPDATE notes SET is_archived = 0 WHERE is_archived IS NULL"))

    if "archived_at" not in cols:
        op.add_column(_TABLE, sa.Column("archived_at", sa.DateTime(), nullable=True))

    # Partial index: the archived set is expected to stay small next to the
    # live corpus, so indexing only the archived rows keeps the archive read
    # cheap without paying an index write on every ordinary note save.
    op.execute(
        sa.text(
            "CREATE INDEX IF NOT EXISTS ix_notes_is_archived "
            "ON notes (is_archived) WHERE is_archived = 1"
        )
    )


def downgrade():
    bind = op.get_bind()
    cols = _columns(bind)
    if not cols:
        return
    op.execute(sa.text("DROP INDEX IF EXISTS ix_notes_is_archived"))
    # Dropping loses only the archived/not bit — nothing about a note's
    # content depends on it, so a rollback leaves every note intact and
    # simply visible again.
    with op.batch_alter_table(_TABLE) as batch:
        if "archived_at" in cols:
            batch.drop_column("archived_at")
        if "is_archived" in cols:
            batch.drop_column("is_archived")
