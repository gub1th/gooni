"""add promises + edges tables

Revision ID: 77b1743b2ebc
Revises: d2350b76ef42
Create Date: 2026-05-16

Two new tables for the WA promises layer:

- `promises`: soft commitments extracted from chat ("imma X tonight").
  Distinct primitive from Todo / Focus. Carries the verbatim utterance,
  inferred deadline, lifecycle state, and slip_count for accountability.
- `edges`: graph layer for semantic many-to-many links across entities
  (e.g. Promise supports Focus, Promise closes Todo). Existing FKs stay
  for ownership; new cross-entity links land here so the schema doesn't
  M²-explode when new primitives arrive.

Autogen drift was scrubbed by hand — these are the only real changes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '77b1743b2ebc'
down_revision: Union[str, Sequence[str], None] = 'd2350b76ef42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'promises',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('utterance', sa.Text(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('inferred_due', sa.DateTime(), nullable=True),
        sa.Column('state', sa.String(), nullable=False, server_default='pending'),
        sa.Column('slip_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('resolved_at', sa.DateTime(), nullable=True),
        sa.Column('source_message_id', sa.Integer(), nullable=True),
        sa.Column('embedding', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['source_message_id'], ['messages.id']),
    )
    op.create_index('ix_promises_id', 'promises', ['id'])
    op.create_index('ix_promises_state', 'promises', ['state'])
    op.create_index('ix_promises_source_message_id', 'promises', ['source_message_id'])

    op.create_table(
        'edges',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('src_kind', sa.String(), nullable=False),
        sa.Column('src_id', sa.Integer(), nullable=False),
        sa.Column('dst_kind', sa.String(), nullable=False),
        sa.Column('dst_id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('weight', sa.Float(), nullable=True),
        sa.Column('metadata_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            'src_kind', 'src_id', 'dst_kind', 'dst_id', 'kind',
            name='uq_edges_endpoints_kind',
        ),
    )
    op.create_index('ix_edges_id', 'edges', ['id'])
    op.create_index('ix_edges_src', 'edges', ['src_kind', 'src_id'])
    op.create_index('ix_edges_dst', 'edges', ['dst_kind', 'dst_id'])


def downgrade() -> None:
    op.drop_index('ix_edges_dst', table_name='edges')
    op.drop_index('ix_edges_src', table_name='edges')
    op.drop_index('ix_edges_id', table_name='edges')
    op.drop_table('edges')

    op.drop_index('ix_promises_source_message_id', table_name='promises')
    op.drop_index('ix_promises_state', table_name='promises')
    op.drop_index('ix_promises_id', table_name='promises')
    op.drop_table('promises')
