"""add daily_metrics table

Revision ID: b2f4a1c7d3e9
Revises: 4de39b31ce1e
Create Date: 2026-05-24 12:00:00.000000

PR-1 fitness/cut pipeline. Numeric daily tracking (calories/protein/weight/
exercise) — standalone from habits (which stay boolean). Inspector-guarded
so a re-run against a partially-applied DB is a no-op (matches repo
convention + the _alembic_upgrade boot recovery).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2f4a1c7d3e9'
down_revision: Union[str, Sequence[str], None] = '4de39b31ce1e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'daily_metrics' not in set(inspector.get_table_names()):
        op.create_table(
            'daily_metrics',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('metric_type', sa.String(), nullable=False),
            sa.Column('value', sa.Float(), nullable=False),
            sa.Column('unit', sa.String(), nullable=True),
            sa.Column('date', sa.Date(), nullable=False),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('id'),
        )

    existing_indexes = {
        ix['name'] for ix in sa.inspect(bind).get_indexes('daily_metrics')
    }
    with op.batch_alter_table('daily_metrics', schema=None) as batch_op:
        if 'ix_daily_metrics_id' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_daily_metrics_id'), ['id'], unique=False)
        if 'ix_daily_metrics_metric_type' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_daily_metrics_metric_type'), ['metric_type'], unique=False)
        if 'ix_daily_metrics_date' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_daily_metrics_date'), ['date'], unique=False)
        if 'ix_daily_metrics_type_date' not in existing_indexes:
            batch_op.create_index('ix_daily_metrics_type_date', ['metric_type', 'date'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('daily_metrics', schema=None) as batch_op:
        batch_op.drop_index('ix_daily_metrics_type_date')
        batch_op.drop_index(batch_op.f('ix_daily_metrics_date'))
        batch_op.drop_index(batch_op.f('ix_daily_metrics_metric_type'))
        batch_op.drop_index(batch_op.f('ix_daily_metrics_id'))
    op.drop_table('daily_metrics')
