"""drop whoop_snapshots + leetcode_snapshots (feeds → Trackable)

Ambient-loop v2 Slice 5. Both integrations now write the `whoop` /
`leetcode` json master Trackables (+ numeric mirrors). Old snapshot rows
are discarded, not migrated — both sources are refetchable upstream
(nuclear-friendly per the slice spec). GooniSnapshot + TrackedRepo drop
lands with their consumers in the Slice 6 nuke sweep.

Revision ID: d2f5a8c1e9b3
Revises: c9e2f7a4b8d1
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d2f5a8c1e9b3"
down_revision = "c9e2f7a4b8d1"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("whoop_snapshots", "leetcode_snapshots"):
        if inspector.has_table(table):
            op.drop_table(table)


def downgrade():
    # Forward-only: the data was discarded (refetchable upstream) and the
    # replacement lives in trackable_entries.
    pass
