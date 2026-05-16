"""add wa_processed_ids table

Revision ID: 3d057ff39f90
Revises: a0efb28c711f
Create Date: 2026-05-13 22:16:18.320781

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '3d057ff39f90'
down_revision: Union[str, Sequence[str], None] = 'a0efb28c711f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema. Idempotent against partial prior runs.

    Adds the idempotency log for inbound WhatsApp messages. UNIQUE on `wamid`
    is enforced via PK so a Meta retry that races the original delivery hits
    IntegrityError instead of double-firing the orchestrator.

    Idempotency: same partial-state recovery pattern as #185 / #197 / habits
    fix — the migration ahead of this one (a0efb28c711f habits) crashed
    before alembic stamped, so the prod DB has wa_processed_ids already
    sitting from a prior partial run. Guard each DDL op via inspect().
    """
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if 'wa_processed_ids' not in existing_tables:
        op.create_table(
            'wa_processed_ids',
            sa.Column('wamid', sa.String(), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('wamid'),
        )

    existing_indexes = (
        {ix['name'] for ix in inspect(bind).get_indexes('wa_processed_ids')}
        if 'wa_processed_ids' in existing_tables
        or 'wa_processed_ids' in set(inspect(bind).get_table_names())
        else set()
    )
    with op.batch_alter_table('wa_processed_ids', schema=None) as batch_op:
        if 'ix_wa_processed_ids_created_at' not in existing_indexes:
            batch_op.create_index(
                batch_op.f('ix_wa_processed_ids_created_at'),
                ['created_at'],
                unique=False,
            )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('wa_processed_ids', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_wa_processed_ids_created_at'))
    op.drop_table('wa_processed_ids')
