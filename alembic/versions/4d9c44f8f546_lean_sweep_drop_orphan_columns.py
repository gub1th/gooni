"""lean sweep — drop orphan columns left by the v2 nuke + nudge reset

Two groups, both zero-reader verified (grep app/ frontend/ mcp/ scripts/):

1. Nudge reset (2026-07): the daily digest + proactive nudges died, so their
   Settings knobs/idempotency tokens go. `nudge_tz` SURVIVES — it's the
   app-wide canonical timezone (local_today reads it).
2. v2-nuke stragglers: columns whose feature died in e8b3c6d9f2a7 but whose
   physical DROP was skipped (SQLite FK quirks) or never attempted —
   notes.status graduation lifecycle, the 5am-batch session-summary cluster,
   backlog FK, plus the unmapped leftovers the nuke's best-effort pass
   couldn't drop (notes.space_id, conversations.space_id, memories.focus_id,
   attachments.todo_id). batch_op rebuilds the table so FK-definition
   references can't block the drop this time.

Every drop is inspector-guarded so re-runs (and DBs where the nuke's
best-effort pass DID succeed) are no-ops. Forward-only, like the nuke.

Revision ID: 4d9c44f8f546
Revises: e8b3c6d9f2a7
Create Date: 2026-07-10
"""
import sqlalchemy as sa
from alembic import op

revision = "4d9c44f8f546"
down_revision = "e8b3c6d9f2a7"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _indexes(bind, table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def _drop_columns(table: str, columns: list[str]) -> None:
    bind = op.get_bind()
    present = [c for c in columns if c in _cols(bind, table)]
    if not present:
        return
    # Dead FK columns still reference tables the nuke dropped (spaces,
    # list_items, todos, …). batch_alter_table reflects the source table and
    # reflection follows every FK — NoSuchTableError on the missing parents.
    # Stand up empty phantoms for the duration of the rebuild, then drop them.
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    referred = {
        fk["referred_table"] for fk in insp.get_foreign_keys(table)
    }
    phantoms = referred - tables
    for name in phantoms:
        op.execute(sa.text(f"CREATE TABLE {name} (id INTEGER PRIMARY KEY)"))
    try:
        # Indexes touching a dropped column must go first — batch mode
        # recreates the table and would otherwise re-emit a broken index
        # (e.g. ix_attachments_todo_id on the vanished todo_id).
        doomed_idx = [
            i["name"]
            for i in insp.get_indexes(table)
            if set(i["column_names"]) & set(present)
        ]
        with op.batch_alter_table(table) as batch:
            for idx in doomed_idx:
                batch.drop_index(idx)
            for col in present:
                batch.drop_column(col)
    finally:
        for name in phantoms:
            op.execute(sa.text(f"DROP TABLE IF EXISTS {name}"))


def upgrade() -> None:
    _drop_columns("settings", [
        # daily digest (system deleted)
        "nudge_enabled", "nudge_hour", "nudge_minute", "nudge_channels",
        "nudge_last_sent_day", "nudge_last_digests", "nudge_prompt",
        # proactive nudges (system deleted)
        "last_whoop_nudge_source_ts", "last_sleep_nudge_day",
        "sleep_cutoff_hour", "whoop_nudge_pending_source_ts",
        "whoop_nudge_pending_set_at",
        # dead loop idempotency stamps (loops died in the nuke)
        "batch_last_run_day", "capability_telemetry_last_run_day",
    ])
    _drop_columns("notes", [
        "status",            # graduation lifecycle — driver (synthesizer) nuked
        "note_type", "session_start", "session_end", "message_count",  # 5am batch
        "backlog_note_id",   # backlog space FK
        "space_id",          # nuke straggler (FK-def blocked the plain DROP)
    ])
    _drop_columns("conversations", ["space_id"])
    _drop_columns("memories", ["focus_id"])
    _drop_columns("attachments", ["todo_id"])


def downgrade() -> None:
    raise NotImplementedError(
        "forward-only, same policy as the v2 nuke (e8b3c6d9f2a7) — git is the rollback"
    )
