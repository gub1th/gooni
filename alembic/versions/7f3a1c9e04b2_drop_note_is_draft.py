"""drop notes.is_draft — the draft concept is gone

Drafts were a three-state publish ceremony (draft → private → public) whose
middle state was never real: `/public` filters on `is_public` ALONE, so
`draft` and `private (final)` were byte-identical to every consumer — same
visibility, same search, same feeds. The only thing that differed was which
label `PublishButton` rendered. Two states remain: private (the default) and
public.

Hand-written, not autogenerate: autogenerate against a non-head local DB
wants to drop `notes_fts` and every v2-nuked table (see 2d8404bfd652).

`downgrade()` recreates the column with its old default so a rollback yields a
schema the previous code can run against. It CANNOT restore which notes were
drafts — that bit is destroyed here, and there is nowhere to stash it that
isn't itself a new column. Every note comes back as a non-draft, which is what
the old default was and is the safe direction: a note wrongly marked draft
would reappear in a sidebar section claiming you meant to publish it.

Revision ID: 7f3a1c9e04b2
Revises: 2d8404bfd652
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7f3a1c9e04b2"
down_revision: Union[str, Sequence[str], None] = "2d8404bfd652"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("notes")}
    if "is_draft" in cols:
        with op.batch_alter_table("notes", schema=None) as batch_op:
            batch_op.drop_column("is_draft")


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("notes")}
    if "is_draft" not in cols:
        op.add_column(
            "notes",
            sa.Column(
                "is_draft",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
