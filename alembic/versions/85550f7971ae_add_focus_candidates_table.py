"""add focus_candidates table

Revision ID: 85550f7971ae
Revises: 8ee76e459df5
Create Date: 2026-05-11 23:41:09.704638

Narrow scope: only creates the new table + its indexes. Autogen also
surfaced unrelated SQLite cosmetic drift + legacy-backup cleanup; those
belong in a dedicated cleanup PR, not bundled here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '85550f7971ae'
down_revision: Union[str, Sequence[str], None] = '8ee76e459df5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'focus_candidates',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('endgoal', sa.Text(), nullable=True),
        sa.Column('category', sa.String(), nullable=False),
        sa.Column('confidence', sa.Float(), nullable=False),
        sa.Column('reasoning', sa.Text(), nullable=True),
        sa.Column('cluster_signature', sa.String(), nullable=False),
        sa.Column('evidence_json', sa.Text(), nullable=False),
        sa.Column('centroid_embedding', sa.Text(), nullable=True),
        sa.Column('parent_candidate_id', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('promoted_focus_id', sa.Integer(), nullable=True),
        sa.Column('promoted_at', sa.DateTime(), nullable=True),
        sa.Column('dismissed_at', sa.DateTime(), nullable=True),
        sa.Column('first_seen_in_synth', sa.DateTime(), nullable=False),
        sa.Column('last_seen_in_synth', sa.DateTime(), nullable=False),
        sa.Column('seen_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['parent_candidate_id'], ['focus_candidates.id'], ),
        sa.ForeignKeyConstraint(['promoted_focus_id'], ['focuses.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('focus_candidates', schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f('ix_focus_candidates_cluster_signature'),
            ['cluster_signature'], unique=True,
        )
        batch_op.create_index(
            batch_op.f('ix_focus_candidates_id'), ['id'], unique=False,
        )
        batch_op.create_index(
            batch_op.f('ix_focus_candidates_parent_candidate_id'),
            ['parent_candidate_id'], unique=False,
        )
        batch_op.create_index(
            batch_op.f('ix_focus_candidates_promoted_focus_id'),
            ['promoted_focus_id'], unique=False,
        )
        batch_op.create_index(
            batch_op.f('ix_focus_candidates_status'), ['status'], unique=False,
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('focus_candidates', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_focus_candidates_status'))
        batch_op.drop_index(batch_op.f('ix_focus_candidates_promoted_focus_id'))
        batch_op.drop_index(batch_op.f('ix_focus_candidates_parent_candidate_id'))
        batch_op.drop_index(batch_op.f('ix_focus_candidates_id'))
        batch_op.drop_index(batch_op.f('ix_focus_candidates_cluster_signature'))
    op.drop_table('focus_candidates')
