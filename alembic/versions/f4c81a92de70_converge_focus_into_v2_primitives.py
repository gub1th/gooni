"""Converge the focus system into the v2 primitives (EXPAND half).

Adds the three columns v2 needs to absorb the focus vocabulary, then BACKFILLS
every focus row into Notes/Promises. The four absorbed tables are deliberately
LEFT IN PLACE and unread — this is the expand half of expand/contract, so the
originals stay available for a diff (`scripts/verify_focus_convergence.py`) and
a follow-up migration drops them once the backfill has been eyeballed in prod.

Mapping:
    thought_batches → notes (tag `thought-batch`, title = Claude's label)
    thought_batches.image_url → attachments (note-owned already)
    thoughts        → notes (tag `thought`, parent_note_id → batch note)
    reminders       → promises (+ owed_to, due_is_default)
    reminders.thought_id → edges (promise → note, kind `derives_from`)
    mentions        → dropped (0 rows, no writer, no tool ever populated it)

DEDUP — and the repair that goes with it. Revision `d1a4c7f2b8e6` (2026-08-01)
already COPIED every reminder into `promises` so the B4 dashboard could read
them, then left both tables live: the connector kept writing `reminders` while
B4 read `promises`, and the two copies drifted. That's why all four prod
reminders had verbatim promise twins by 2026-08-08.

So a reminder is matched to its twin by the `migrated_from_reminder` edge that
migration left behind (exact), falling back to a text match for rows the
connector wrote afterwards. Only a genuinely new reminder is inserted.

Adopting a twin also REPAIRS what the earlier copy had to drop, because v2
Promise had nowhere to put it at the time and now does:
  - `owed_to` was folded into the summary as an "owed to {name}: " prefix.
    The FK is restored and the prefix stripped, so the person renders once.
  - a DEFAULTED due was migrated to NULL, because carrying it would have
    painted the promise overdue for a deadline nobody chose. `due_is_default`
    now exists on Promise and `auto_mark_overdue` honors it, so the date is
    restored — which also puts those rows back on the dashboard's short-term
    split instead of stranding them dateless in "longer term".

Raw SQL throughout, not the ORM: a data migration must describe the schema as
it is at THIS revision, and the models keep moving.

Revision ID: f4c81a92de70
Revises: d1a4c7f2b8e6
Create Date: 2026-08-08
"""

from alembic import op
import sqlalchemy as sa

revision = "f4c81a92de70"
down_revision = "d1a4c7f2b8e6"
branch_labels = None
depends_on = None


THOUGHT_TAG = '["thought"]'
BATCH_TAG = '["thought-batch"]'


def _cols(bind, table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade():
    bind = op.get_bind()
    tables = _tables(bind)

    # ── schema (guarded so a re-run is a no-op) ──────────────────────────────
    if "notes" in tables and "topic_id" not in _cols(bind, "notes"):
        op.add_column("notes", sa.Column("topic_id", sa.Integer(), nullable=True))
        op.create_index(
            "ix_notes_topic_id", "notes", ["topic_id"], if_not_exists=True
        )

    promise_cols = _cols(bind, "promises") if "promises" in tables else set()
    if "promises" in tables and "owed_to" not in promise_cols:
        op.add_column("promises", sa.Column("owed_to", sa.Integer(), nullable=True))
        op.create_index(
            "ix_promises_owed_to", "promises", ["owed_to"], if_not_exists=True
        )
    if "promises" in tables and "due_is_default" not in promise_cols:
        # server_default so the existing rows get a value; the model carries the
        # Python-side default for new inserts.
        op.add_column(
            "promises",
            sa.Column(
                "due_is_default",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            ),
        )

    # ── backfill ─────────────────────────────────────────────────────────────
    # Idempotent by construction: every insert is gated on the target not
    # already existing, so re-running after a partial failure resumes cleanly.
    if not {"thought_batches", "thoughts", "reminders"} & tables:
        return  # fresh DB — nothing to carry over

    if "thought_batches" in tables:
        _migrate_batches(bind)
    if "thoughts" in tables:
        _migrate_thoughts(bind)
    if "reminders" in tables:
        _migrate_reminders(bind)


def _migrate_batches(bind) -> None:
    """thought_batches → notes(tag thought-batch), image_url → attachments."""
    rows = bind.execute(
        sa.text(
            "SELECT id, topic_id, label, image_url, started_at, ended_at "
            "FROM thought_batches ORDER BY id"
        )
    ).fetchall()
    for r in rows:
        existing = bind.execute(
            sa.text(
                "SELECT id FROM notes WHERE tags = :tag AND topic_id IS :topic "
                "AND created_at = :created LIMIT 1"
            ),
            {"tag": BATCH_TAG, "topic": r.topic_id, "created": r.started_at},
        ).scalar()
        if existing:
            note_id = existing
        else:
            note_id = bind.execute(
                sa.text(
                    "INSERT INTO notes "
                    "(title, content, excerpt, tags, topic_id, created_at, "
                    " updated_at, is_public, is_pinned, is_public_pinned, is_draft) "
                    "VALUES (:title, '', :excerpt, :tags, :topic, :created, "
                    " :updated, 0, 0, 0, 0) RETURNING id"
                ),
                {
                    "title": r.label,
                    "excerpt": (r.label or "")[:240],
                    "tags": BATCH_TAG,
                    "topic": r.topic_id,
                    "created": r.started_at,
                    "updated": r.ended_at,
                },
            ).scalar()

        if r.image_url:
            has_att = bind.execute(
                sa.text("SELECT 1 FROM attachments WHERE note_id = :n LIMIT 1"),
                {"n": note_id},
            ).scalar()
            if not has_att:
                filename = r.image_url.rsplit("/", 1)[-1] or "image"
                bind.execute(
                    sa.text(
                        "INSERT INTO attachments "
                        "(note_id, filename, mime_type, size_bytes, storage_key, "
                        " public_url, created_at) "
                        "VALUES (:n, :f, :m, 0, :k, :u, :c)"
                    ),
                    {
                        "n": note_id,
                        "f": filename,
                        "m": "image/png"
                        if filename.lower().endswith(".png")
                        else "image/jpeg",
                        "k": r.image_url.split(".r2.dev/", 1)[-1]
                        if ".r2.dev/" in r.image_url
                        else filename,
                        "u": r.image_url,
                        "c": r.started_at,
                    },
                )


def _batch_note_map(bind) -> dict:
    """old thought_batches.id → new notes.id, matched on (topic, started_at)."""
    out = {}
    rows = bind.execute(
        sa.text("SELECT id, topic_id, started_at FROM thought_batches")
    ).fetchall()
    for r in rows:
        nid = bind.execute(
            sa.text(
                "SELECT id FROM notes WHERE tags = :tag AND topic_id IS :topic "
                "AND created_at = :created LIMIT 1"
            ),
            {"tag": BATCH_TAG, "topic": r.topic_id, "created": r.started_at},
        ).scalar()
        if nid:
            out[r.id] = nid
    return out


def _migrate_thoughts(bind) -> None:
    """thoughts → notes(tag thought), parented to the migrated batch note."""
    batch_map = _batch_note_map(bind)
    rows = bind.execute(
        sa.text(
            "SELECT t.id, t.content, t.timestamp, t.batch_id, b.topic_id "
            "FROM thoughts t LEFT JOIN thought_batches b ON b.id = t.batch_id "
            "ORDER BY t.id"
        )
    ).fetchall()
    for r in rows:
        parent = batch_map.get(r.batch_id)
        exists = bind.execute(
            sa.text(
                "SELECT 1 FROM notes WHERE tags = :tag AND created_at = :created "
                "AND content = :content LIMIT 1"
            ),
            {"tag": THOUGHT_TAG, "created": r.timestamp, "content": r.content},
        ).scalar()
        if exists:
            continue
        bind.execute(
            sa.text(
                "INSERT INTO notes "
                "(title, content, excerpt, tags, topic_id, parent_note_id, "
                " created_at, updated_at, is_public, is_pinned, is_public_pinned, "
                " is_draft) "
                "VALUES (NULL, :content, :excerpt, :tags, :topic, :parent, "
                " :created, :created, 0, 0, 0, 0)"
            ),
            {
                "content": r.content,
                "excerpt": (r.content or "")[:240],
                "tags": THOUGHT_TAG,
                "topic": r.topic_id,
                "parent": parent,
                "created": r.timestamp,
            },
        )


def _thought_note_map(bind) -> dict:
    """old thoughts.id → new notes.id, matched on (timestamp, content)."""
    out = {}
    rows = bind.execute(sa.text("SELECT id, content, timestamp FROM thoughts")).fetchall()
    for r in rows:
        nid = bind.execute(
            sa.text(
                "SELECT id FROM notes WHERE tags = :tag AND created_at = :created "
                "AND content = :content LIMIT 1"
            ),
            {"tag": THOUGHT_TAG, "created": r.timestamp, "content": r.content},
        ).scalar()
        if nid:
            out[r.id] = nid
    return out


def _prior_migration_map(bind) -> dict:
    """reminder id → promise id, from the edges `d1a4c7f2b8e6` left behind.

    Exact provenance beats a text match: that migration copied the rows, so it
    knows which promise came from which reminder even when the text has since
    been edited on one side.
    """
    rows = bind.execute(
        sa.text(
            "SELECT src_id, dst_id FROM edges "
            "WHERE kind = 'migrated_from_reminder' AND dst_kind = 'promise'"
        )
    ).fetchall()
    out = {}
    for src, dst in rows:
        out.setdefault(src, dst)
    return out


def _repair_twin(bind, promise_id: int, r) -> None:
    """Restore what `d1a4c7f2b8e6` had to drop when it copied this reminder.

    Never stomps a real value — only fills a gap the earlier copy left.
    """
    twin = bind.execute(
        sa.text(
            "SELECT owed_to, summary, inferred_due, due_is_default "
            "FROM promises WHERE id = :i"
        ),
        {"i": promise_id},
    ).fetchone()
    if twin is None:
        return

    # owed_to: the FK is back, so the "owed to {name}: " summary prefix the old
    # copy used as a stand-in becomes a duplicate label. Restore one, drop the
    # other.
    if r.owed_to is not None and twin.owed_to is None:
        name = bind.execute(
            sa.text("SELECT name FROM focus_people WHERE id = :i"), {"i": r.owed_to}
        ).scalar()
        summary = twin.summary or ""
        prefix = f"owed to {name}: " if name else None
        if prefix and summary.startswith(prefix):
            summary = summary[len(prefix):]
        bind.execute(
            sa.text("UPDATE promises SET owed_to = :o, summary = :s WHERE id = :i"),
            {"o": r.owed_to, "s": summary, "i": promise_id},
        )

    # A defaulted due was migrated to NULL because Promise couldn't mark it as
    # Gooni-invented. It can now, and auto_mark_overdue skips it, so restoring
    # the date is safe — and puts the row back on the short-term split.
    if r.due_is_default and r.due_at and twin.inferred_due is None:
        bind.execute(
            sa.text(
                "UPDATE promises SET inferred_due = :d, due_is_default = 1, "
                "needs_clarification = 0 WHERE id = :i"
            ),
            {"d": r.due_at, "i": promise_id},
        )
    elif r.due_is_default and not twin.due_is_default:
        bind.execute(
            sa.text("UPDATE promises SET due_is_default = 1 WHERE id = :i"),
            {"i": promise_id},
        )


def _migrate_reminders(bind) -> None:
    """reminders → promises, adopting (and repairing) an existing twin."""
    thought_map = _thought_note_map(bind)
    prior = _prior_migration_map(bind)
    rows = bind.execute(
        sa.text(
            "SELECT id, type, content, owed_to, due_at, due_is_default, done, "
            "       state, resolved_at, thought_id, created_at "
            "FROM reminders ORDER BY id"
        )
    ).fetchall()
    for r in rows:
        content = (r.content or "").strip()
        if not content:
            continue

        # 1) exact provenance from the 2026-08-01 copy
        promise_id = prior.get(r.id)
        # 2) text match for reminders the connector wrote after that migration
        if promise_id is None:
            twin = bind.execute(
                sa.text(
                    "SELECT id FROM promises "
                    "WHERE lower(trim(utterance)) = lower(:c) "
                    "ORDER BY (state = 'active') DESC, id ASC LIMIT 1"
                ),
                {"c": content.lower()},
            ).fetchone()
            promise_id = twin.id if twin else None

        if promise_id is not None:
            _repair_twin(bind, promise_id, r)
        else:
            promise_id = bind.execute(
                sa.text(
                    "INSERT INTO promises "
                    "(cadence, cadence_target, is_important, parent_promise_id, "
                    " utterance, summary, inferred_due, state, needs_clarification, "
                    " slip_count, resolved_at, source_message_id, owed_to, "
                    " due_is_default, created_at, updated_at) "
                    "VALUES ('once', NULL, 0, NULL, :u, :s, :due, :state, 0, 0, "
                    " :resolved, NULL, :owed, :dflt, :created, :created) "
                    "RETURNING id"
                ),
                {
                    "u": content,
                    "s": content[:200],
                    "due": r.due_at,
                    # `done` without an explicit state means the legacy check-off
                    # was ticked; that's a kept commitment.
                    "state": r.state or ("kept" if r.done else "active"),
                    "resolved": r.resolved_at,
                    "owed": r.owed_to,
                    "dflt": 1 if r.due_is_default else 0,
                    "created": r.created_at,
                },
            ).scalar()

        if r.thought_id and thought_map.get(r.thought_id):
            note_id = thought_map[r.thought_id]
            dup = bind.execute(
                sa.text(
                    "SELECT 1 FROM edges WHERE src_kind='promise' AND src_id=:p "
                    "AND dst_kind='note' AND dst_id=:n AND kind='derives_from' LIMIT 1"
                ),
                {"p": promise_id, "n": note_id},
            ).scalar()
            if not dup:
                bind.execute(
                    sa.text(
                        "INSERT INTO edges "
                        "(src_kind, src_id, dst_kind, dst_id, kind, created_at) "
                        "VALUES ('promise', :p, 'note', :n, 'derives_from', :c)"
                    ),
                    {"p": promise_id, "n": note_id, "c": r.created_at},
                )


def downgrade():
    """Drop the three added columns. The backfilled Notes/Promises are LEFT —
    deleting user-visible rows on a downgrade is worse than leaving duplicates.

    RECOVERABILITY, as of `b8f3d1c07a45` (the contract half): the source tables
    are no longer standing beside the v2 rows. They come back through the
    `converged_from_*` provenance edges that migration stamps before it drops
    them — its own `downgrade()` walks those edges and rebuilds each row with its
    original id. So a rollback that lands below this revision has to pass through
    `b8f3d1c07a45.downgrade()` first; the edges, not the old tables, are what
    makes it reversible."""
    bind = op.get_bind()
    tables = _tables(bind)
    if "promises" in tables:
        cols = _cols(bind, "promises")
        # The index has to go BEFORE the batch rebuild: batch_alter_table
        # reflects the table, builds the replacement without the column, then
        # replays every reflected index onto it — including one that now names a
        # column that isn't there.
        _drop_index(bind, "promises", "ix_promises_owed_to")
        with op.batch_alter_table("promises") as batch:
            if "due_is_default" in cols:
                batch.drop_column("due_is_default")
            if "owed_to" in cols:
                batch.drop_column("owed_to")
    if "notes" in tables and "topic_id" in _cols(bind, "notes"):
        _drop_index(bind, "notes", "ix_notes_topic_id")
        with op.batch_alter_table("notes") as batch:
            batch.drop_column("topic_id")


def _drop_index(bind, table: str, name: str) -> None:
    if any(i["name"] == name for i in sa.inspect(bind).get_indexes(table)):
        op.drop_index(name, table_name=table)
