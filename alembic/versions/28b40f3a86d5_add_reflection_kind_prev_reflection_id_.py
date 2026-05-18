"""add reflection kind, prev_reflection_id, score

Revision ID: 28b40f3a86d5
Revises: 5503af7a71e6
Create Date: 2026-05-18 02:52:36.779502

Three additive columns on `reflections`:

- kind                : 'turn' | 'conv_rollup' (default 'turn'). Discriminator
                        so conv-level rollup summaries coexist with per-turn
                        reflections in the same table.
- prev_reflection_id  : self-FK to the prior reflection in the same conv.
                        Lets each new reflection see its lineage during
                        anti-redundancy checks.
- score               : 1-10 quality score derived from gap_dimension +
                        severity. Nullable so legacy / parse-failed rows
                        don't break aggregations.

All three are nullable or have defaults so the migration is non-destructive
on existing rows. Inspector-guarded per CLAUDE.md convention.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '28b40f3a86d5'
down_revision: Union[str, Sequence[str], None] = '5503af7a71e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("reflections"):
        # Fresh DB w/o reflections table — nothing to alter. SQLAlchemy
        # metadata.create_all (via boot) handles full table creation.
        return

    existing_cols = {c["name"] for c in inspector.get_columns("reflections")}
    with op.batch_alter_table("reflections", schema=None) as batch_op:
        if "kind" not in existing_cols:
            batch_op.add_column(
                sa.Column(
                    "kind",
                    sa.String(),
                    nullable=False,
                    server_default="turn",
                )
            )
        if "prev_reflection_id" not in existing_cols:
            batch_op.add_column(
                sa.Column(
                    "prev_reflection_id",
                    sa.Integer(),
                    nullable=True,
                )
            )
        if "score" not in existing_cols:
            batch_op.add_column(
                sa.Column("score", sa.Float(), nullable=True)
            )

    existing_indexes = {ix["name"] for ix in inspector.get_indexes("reflections")}
    with op.batch_alter_table("reflections", schema=None) as batch_op:
        if "ix_reflections_kind" not in existing_indexes:
            batch_op.create_index(
                "ix_reflections_kind", ["kind"], unique=False
            )
        if "ix_reflections_prev_reflection_id" not in existing_indexes:
            batch_op.create_index(
                "ix_reflections_prev_reflection_id",
                ["prev_reflection_id"],
                unique=False,
            )


def downgrade() -> None:
    with op.batch_alter_table("reflections", schema=None) as batch_op:
        batch_op.drop_index("ix_reflections_prev_reflection_id")
        batch_op.drop_index("ix_reflections_kind")
        batch_op.drop_column("score")
        batch_op.drop_column("prev_reflection_id")
        batch_op.drop_column("kind")
