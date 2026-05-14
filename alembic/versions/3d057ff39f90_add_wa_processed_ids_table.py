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
    """Upgrade schema.

    Adds the idempotency log for inbound WhatsApp messages. UNIQUE on `wamid`
    is enforced via PK so a Meta retry that races the original delivery hits
    IntegrityError instead of double-firing the orchestrator.

    Autogenerate also surfaced SQLite-cosmetic drift on focuses/habits/notes
    (server_default reads back as None) and FK noise on list_items/memories/notes
    that exists on the current schema but isn't introduced by this change.
    Scrubbed out — keep this migration scoped to the one real addition.
    """
    op.create_table(
        'wa_processed_ids',
        sa.Column('wamid', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('wamid'),
    )
    with op.batch_alter_table('wa_processed_ids', schema=None) as batch_op:
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
