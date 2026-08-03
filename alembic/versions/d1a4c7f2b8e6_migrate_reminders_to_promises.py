"""migrate Focus Reminder rows → v2 Promise

Convergence step (2026-08-01): the B4 dashboard reads v2 primitives only.
The promise data + lifecycle lived in the Focus `reminders` table (fed by
the claude.ai MCP connector's set_reminder); this copies every reminder into
the v2 `promises` table so B4 shows your existing commitments. The reminders
table + /focus routes stay in place (dead weight) until the connector is
repointed to write v2 directly.

Field map (Reminder → Promise):
  content            → utterance (+ summary; summary prefixes "owed to {name}:"
                       when owed_to is set, so people-context survives without
                       a new column — v2 Promise has no owed_to)
  state              → state           (identical vocab: active|kept|broken)
  resolved_at        → resolved_at
  created_at         → created_at / updated_at
  due_at             → inferred_due, BUT ONLY when the user chose the deadline
                       (due_is_default = 0). A defaulted due was invented by
                       Gooni; carrying it would paint the promise "overdue" for
                       a deadline never made — exactly what due_is_default
                       exists to prevent — so it migrates to NULL (a dateless,
                       vague active promise → needs_clarification=1).
  cadence            → 'once'          (reminders are one-shot)
  (dropped: type nuance, owed_to FK, due_is_default, done, thought_id, parent_id)

Provenance + idempotency ride the edges table: each migrated reminder gets a
('reminder', rid) --migrated_from_reminder--> ('promise', pid) edge. The whole
migration no-ops if any such edge already exists (mirrors the daily_metrics
"skip if already migrated" guard, since promises has no source column).

Revision ID: d1a4c7f2b8e6
Revises: b6e4c2a9d713
Create Date: 2026-08-01
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d1a4c7f2b8e6"
down_revision = "b6e4c2a9d713"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Nothing to migrate on a fresh DB that never had the Focus tables.
    if not inspector.has_table("reminders") or not inspector.has_table("promises"):
        return

    # Idempotency: bail if this migration already produced promises.
    already = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM edges WHERE kind = 'migrated_from_reminder'"
        )
    ).fetchone()[0]
    if already:
        return

    rows = bind.execute(
        sa.text(
            "SELECT id, content, owed_to, due_at, due_is_default, state, "
            "resolved_at, created_at FROM reminders ORDER BY id ASC"
        )
    ).fetchall()

    for (
        rid,
        content,
        owed_to,
        due_at,
        due_is_default,
        state,
        resolved_at,
        created_at,
    ) in rows:
        content = content or ""
        # Fold owed_to (a Person FK) into the display summary — v2 Promise has
        # no owed_to, and losing "owed to Yash" would erase why the promise
        # matters. utterance keeps the raw words for provenance.
        summary = content
        if owed_to is not None:
            person = bind.execute(
                sa.text("SELECT name FROM focus_people WHERE id = :i"),
                {"i": owed_to},
            ).fetchone()
            if person and person[0]:
                summary = f"owed to {person[0]}: {content}"

        # Honesty rule: only a user-chosen deadline becomes a real due.
        due = due_at if not due_is_default else None
        needs_clar = 1 if due is None else 0
        st = state or "active"

        res = bind.execute(
            sa.text(
                "INSERT INTO promises "
                "(cadence, is_important, utterance, summary, inferred_due, "
                " state, needs_clarification, slip_count, resolved_at, "
                " created_at, updated_at) "
                "VALUES ('once', 0, :utt, :sum, :due, :st, :nc, 0, :res, "
                " :ca, :ca)"
            ),
            {
                "utt": content,
                "sum": summary,
                "due": due,
                "st": st,
                "nc": needs_clar,
                "res": resolved_at,
                "ca": created_at,
            },
        )
        pid = res.lastrowid

        # Provenance + idempotency marker.
        bind.execute(
            sa.text(
                "INSERT INTO edges "
                "(src_kind, src_id, dst_kind, dst_id, kind, created_at) "
                "VALUES ('reminder', :rid, 'promise', :pid, "
                " 'migrated_from_reminder', CURRENT_TIMESTAMP)"
            ),
            {"rid": rid, "pid": pid},
        )


def downgrade():
    # Undo only what this migration created — the promises it inserted, keyed
    # by the provenance edges. Leaves chat-born promises untouched.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("edges") or not inspector.has_table("promises"):
        return
    pids = [
        r[0]
        for r in bind.execute(
            sa.text(
                "SELECT dst_id FROM edges WHERE kind = 'migrated_from_reminder' "
                "AND dst_kind = 'promise'"
            )
        ).fetchall()
    ]
    for pid in pids:
        bind.execute(
            sa.text("DELETE FROM promises WHERE id = :i"), {"i": pid}
        )
    bind.execute(
        sa.text("DELETE FROM edges WHERE kind = 'migrated_from_reminder'")
    )
