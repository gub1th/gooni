"""add Focus drift cols (initial/current signatures + lineage)

Revision ID: 85055be3f681
Revises: 85550f7971ae
Create Date: 2026-05-12 00:21:00

Narrow scope: only adds the new drift / lineage columns on `focuses`.
Autogen also re-surfaced the same SQLite cosmetic drift + legacy table
cleanup as prior migrations; deferred to a dedicated cleanup PR.

`missed_run_count` carries a server_default of '0' so existing focuses
backfill cleanly without us having to UPDATE the table separately.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '85055be3f681'
down_revision: Union[str, Sequence[str], None] = '85550f7971ae'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('focuses', schema=None) as batch_op:
        batch_op.add_column(sa.Column('initial_signature', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('current_signature', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('current_evidence_json', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('last_seen_in_synth', sa.DateTime(), nullable=True))
        batch_op.add_column(
            sa.Column(
                'missed_run_count', sa.Integer(),
                nullable=False, server_default='0',
            )
        )
        batch_op.add_column(sa.Column('drift_flagged_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column('promoted_from_candidate_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('evolved_from_focus_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_focuses_promoted_from_candidate_id',
            'focus_candidates', ['promoted_from_candidate_id'], ['id'],
        )
        batch_op.create_foreign_key(
            'fk_focuses_evolved_from_focus_id',
            'focuses', ['evolved_from_focus_id'], ['id'],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('focuses', schema=None) as batch_op:
        batch_op.drop_constraint('fk_focuses_evolved_from_focus_id', type_='foreignkey')
        batch_op.drop_constraint('fk_focuses_promoted_from_candidate_id', type_='foreignkey')
        batch_op.drop_column('evolved_from_focus_id')
        batch_op.drop_column('promoted_from_candidate_id')
        batch_op.drop_column('drift_flagged_at')
        batch_op.drop_column('missed_run_count')
        batch_op.drop_column('last_seen_in_synth')
        batch_op.drop_column('current_evidence_json')
        batch_op.drop_column('current_signature')
        batch_op.drop_column('initial_signature')
