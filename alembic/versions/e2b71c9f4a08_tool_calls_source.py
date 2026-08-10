"""tool_calls.source — attribute a tool call to the surface that made it

Backs the converged MCP surface's call logging: every MCP tool invocation now
writes a ToolCall row tagged 'mcp-stdio' (Claude Code) or 'mcp-http' (the
claude.ai connector), so "is this tool used?" is a group-by rather than a
judgement call. Chat-loop rows keep source NULL — nullable on purpose, so no
backfill is needed and no existing row changes meaning.

Revision ID: e2b71c9f4a08
Revises: c4d7e9a1b306
Create Date: 2026-08-10
"""

from alembic import op
import sqlalchemy as sa

revision = "e2b71c9f4a08"
down_revision = "c4d7e9a1b306"
branch_labels = None
depends_on = None

_TABLE = "tool_calls"
_COL = "source"
_INDEX = "ix_tool_calls_source"


def _has_column(inspector, table: str, column: str) -> bool:
    return column in {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    # Inspector-guarded so a re-run is a no-op (repo convention — boot runs
    # `alembic upgrade head` on every uvicorn start).
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE):
        return
    if not _has_column(inspector, _TABLE, _COL):
        op.add_column(_TABLE, sa.Column(_COL, sa.String(), nullable=True))
    op.create_index(_INDEX, _TABLE, [_COL], if_not_exists=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE):
        return
    op.drop_index(_INDEX, table_name=_TABLE, if_exists=True)
    if _has_column(inspector, _TABLE, _COL):
        with op.batch_alter_table(_TABLE) as batch:
            batch.drop_column(_COL)
