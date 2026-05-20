"""promise state collapse 5 to 3 (G3)

Revision ID: 43a0649e9e06
Revises: 5b16a0f9617d
Create Date: 2026-05-20 01:03:03.789641

Collapses Promise.state from 5 → 3 distinct values. Daniel's read: a
promise should always be 'active' (you don't want to stall on one),
then end as either 'kept' or 'broken'. 'proposed' and 'pending' were
process-stage flavors of the same thing; 'abandoned' was a softer
'broken' that didn't earn its slot.

Mapping:
  proposed  → active
  pending   → active
  kept      → kept    (no change)
  broken    → broken  (no change)
  abandoned → broken

Data-only migration. The column is already a free-form String, so no
schema change needed — just UPDATEs.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '43a0649e9e06'
down_revision: Union[str, Sequence[str], None] = '5b16a0f9617d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Collapse Promise.state values."""
    op.execute(
        "UPDATE promises SET state='active' WHERE state IN ('proposed', 'pending')"
    )
    op.execute(
        "UPDATE promises SET state='broken' WHERE state='abandoned'"
    )


def downgrade() -> None:
    """Best-effort reverse: all active → pending. Cannot distinguish
    pre-collapse `proposed` from `pending`, so the proposed lock-in
    state is lost on downgrade. Abandoned-as-broken cannot be
    distinguished from real broken — left as broken.
    """
    op.execute(
        "UPDATE promises SET state='pending' WHERE state='active'"
    )
