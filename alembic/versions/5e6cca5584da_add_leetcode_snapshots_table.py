"""add leetcode_snapshots table

Revision ID: 5e6cca5584da
Revises: e6c2a9b1f4d3
Create Date: 2026-05-09 20:54:00.379281

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5e6cca5584da'
down_revision: Union[str, Sequence[str], None] = 'e6c2a9b1f4d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Idempotent — prod DBs that went through the legacy-cutover boot
    path in `app/main._alembic_upgrade` had `Base.metadata.create_all`
    run BEFORE the baseline stamp, which created every then-current
    model table (including this one) before alembic knew about them.
    When prod later upgrades past baseline and hits this revision, a
    naked CREATE TABLE crashes with "table already exists" and the
    fly machine restart-loops. Skip the create when the table is
    already there; same for the indexes.
    """
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table('leetcode_snapshots'):
        op.create_table(
            'leetcode_snapshots',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('date', sa.Date(), nullable=False),
            sa.Column('username', sa.String(), nullable=False),
            sa.Column('streak', sa.Integer(), nullable=True),
            sa.Column('total_active_days', sa.Integer(), nullable=True),
            sa.Column('today_count', sa.Integer(), nullable=True),
            sa.Column('week_count', sa.Integer(), nullable=True),
            sa.Column('total_solved', sa.Integer(), nullable=True),
            sa.Column('easy_solved', sa.Integer(), nullable=True),
            sa.Column('medium_solved', sa.Integer(), nullable=True),
            sa.Column('hard_solved', sa.Integer(), nullable=True),
            sa.Column('ranking', sa.Integer(), nullable=True),
            sa.Column('calendar_json', sa.Text(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )

    existing_indexes = {ix['name'] for ix in insp.get_indexes('leetcode_snapshots')}
    with op.batch_alter_table('leetcode_snapshots', schema=None) as batch_op:
        if 'ix_leetcode_snapshots_date' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_leetcode_snapshots_date'), ['date'], unique=True)
        if 'ix_leetcode_snapshots_id' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_leetcode_snapshots_id'), ['id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('leetcode_snapshots', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_leetcode_snapshots_id'))
        batch_op.drop_index(batch_op.f('ix_leetcode_snapshots_date'))
    op.drop_table('leetcode_snapshots')
