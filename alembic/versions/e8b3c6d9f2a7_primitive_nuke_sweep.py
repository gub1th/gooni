"""primitive nuke sweep — ambient-loop v2 Slice 6

Drops the 22 pre-v2 primitive tables. Post-sweep core: Note, Promise,
Trackable(+Entry), Message, Edge, Memory (kept per Daniel's override —
chat recall stays) + infra (Conversation, ToolCall, WaProcessedId,
Attachment, Reflection, PublicProfile, Visit, OAuthToken, Settings,
Eval*). Also drops notes.space_id + conversations.space_id (tags replace
Spaces), attachments.todo_id, memories.focus_id.

Nuclear per PRD note #389 — no data migration. DailyMetric history was
already copied to trackable_entries in f3b8d1c6a9e2.

Revision ID: e8b3c6d9f2a7
Revises: d2f5a8c1e9b3
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e8b3c6d9f2a7"
down_revision = "d2f5a8c1e9b3"
branch_labels = None
depends_on = None

_DROP_TABLES = (
    # order irrelevant on SQLite (no FK enforcement), children first anyway
    "focus_session_events",
    "focus_session_buckets",
    "focus_sessions",
    "habit_entries",
    "habits",
    "friction_events",
    "backlog_tickets",
    "todos",
    "focus_candidates",
    "focuses",
    "list_items",
    "lists",
    "note_comments",
    "reactions",
    "gooni_takes",
    "mcp_calls",
    "claude_usage_turns",
    "capability_facets",
    "daily_metrics",
    "gooni_snapshots",
    "tracked_repos",
    "spaces",
)

_DROP_COLUMNS = (
    ("notes", "space_id"),
    ("conversations", "space_id"),
    ("attachments", "todo_id"),
    ("memories", "focus_id"),
)


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _DROP_TABLES:
        if inspector.has_table(table):
            op.drop_table(table)
    # FTS5 shadow tables from the keyword-index migrations reference
    # todos/memories — the todos one is dead weight now. Best-effort.
    for fts in ("todos_fts", "todos_fts_data", "todos_fts_idx",
                "todos_fts_docsize", "todos_fts_config"):
        try:
            bind.execute(sa.text(f"DROP TABLE IF EXISTS {fts}"))
        except Exception:
            pass
    # Raw DROP COLUMN, best-effort. batch_alter_table would reflect the
    # (now-dangling) FK targets and crash; SQLite ≥3.35 handles the plain
    # DROP, and if a given build refuses, the leftover column is harmless
    # dead weight — the models no longer map it, so no query touches it.
    inspector = sa.inspect(bind)
    for table, col in _DROP_COLUMNS:
        if not inspector.has_table(table):
            continue
        cols = {c["name"] for c in inspector.get_columns(table)}
        if col not in cols:
            continue
        try:
            bind.execute(sa.text(f"ALTER TABLE {table} DROP COLUMN {col}"))
        except Exception as e:
            print(f"[nuke] DROP COLUMN {table}.{col} skipped: {e}")


def downgrade():
    # Nuclear forward-only. Git is the rollback.
    raise NotImplementedError("slice 6 nuke is forward-only")
