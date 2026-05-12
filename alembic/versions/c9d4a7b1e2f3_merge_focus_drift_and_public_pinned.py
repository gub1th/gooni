"""merge focus-drift head + is_public_pinned head

Revision ID: c9d4a7b1e2f3
Revises: 85055be3f681, f1a2b3c4d5e6
Create Date: 2026-05-12

The is_public_pinned migration (f1a2b3c4d5e6) and the focus-synthesizer
chain (8ee76e459df5 -> 85550f7971ae -> 85055be3f681) both branched from
the same parent (e4fce556f864), giving alembic two heads. Boot-time
`alembic upgrade head` then fails with "Multiple head revisions are
present" and the app crash-loops past Fly's max restart count.

This empty merge migration declares both as parents, collapsing the
tree back to a single head. No schema changes — just topology.
"""
from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "c9d4a7b1e2f3"
down_revision: Union[str, Sequence[str], None] = ("85055be3f681", "f1a2b3c4d5e6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
