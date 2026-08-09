"""Drop the converged focus tables (CONTRACT half).

`f4c81a92de70` was the EXPAND half: it backfilled `thought_batches`, `thoughts`
and `reminders` into Notes/Promises and deliberately left all four source tables
(those three plus `mentions`) in place, unread, so the backfill could be diffed
in prod. This is the contract half — it drops them.

**RUN `scripts/verify_focus_convergence.py` AGAINST THE TARGET DATABASE AND GET A
ZERO EXIT BEFORE DEPLOYING THIS REVISION. It is the only gate.** The drop here is
UNCONDITIONAL: `upgrade()` stamps provenance and then drops the four tables, with
no per-row check that would refuse. A source row the expand half never absorbed is
destroyed, and `downgrade()` cannot bring it back — it has no edge to walk.

There is no prompt between the deploy and the drop. `_alembic_upgrade()` runs at
import time in `app/main.py`, so `alembic upgrade head` fires on uvicorn boot:
shipping the revision IS running it. Verify first, on the database that will
actually receive it — not a copy that has drifted from prod.

(An in-migration guard was tried and removed on purpose. `promise_service.delete`
wipes the promise AND every edge touching it, so a reminder deleted through the
dashboard legitimately has neither twin nor provenance — a guard keying on that
would refuse to boot forever over an action the user meant to take.)

REVERSIBILITY. A migration that drops production tables has to be able to put
them back, and "recreate four empty tables" is not a downgrade. So `upgrade()`
STAMPS PROVENANCE BEFORE DROPPING: for every source row it writes the edge
recording which v2 row absorbed it, keyed by the ORIGINAL source id.

    thought_batch #N → note #M   kind `converged_from_thought_batch`
    thought       #N → note #M   kind `converged_from_thought`
    reminder      #N → promise #M kind `converged_from_reminder`

These are deliberately NOT `d1a4c7f2b8e6`'s `migrated_from_reminder`. That
migration's `downgrade()` hard-deletes every promise reachable by its own kind on
the premise that it INSERTED them; stamping the same kind onto a promise this
migration merely ADOPTED (connector-written, matched by text) would make
`alembic downgrade b6e4c2a9d713` destroy a user-visible row. One greppable
`converged_from_*` family, written only here, read only here.

`_stamp_reminders` still READS the legacy `migrated_from_reminder` edge as its
first-choice matcher — that exact provenance from the 2026-08-01 copy is how a
reminder is matched even when the text drifted on one side — but it only ever
WRITES the new kind, for every reminder it resolves.

`downgrade()` walks those edges backwards and rebuilds each row — original ids
included, which is what lets `reminders.thought_id` and `thoughts.batch_id` be
restored as real foreign keys rather than dangling integers.

The rebuilt rows come from the v2 side, so a downgrade returns the CURRENT state
of the data, not a snapshot of 2026-08-08. That is the correct direction: edits
made through the connector after this migration ran should survive being rolled
back.

Like the expand half's downgrade, this one LEAVES the backfilled Notes/Promises
alone. Deleting user-visible rows on a rollback is worse than leaving the pair
temporarily duplicated, and the pair is exactly the state the expand half left
prod in for a week.

`mentions` is dropped outright — it never had a writer (none of the six MCP
tools populate it) and had 0 rows. That claim is ASSERTED, not assumed: if the
table somehow holds rows, `upgrade()` raises rather than destroying them.

Raw SQL throughout, not the ORM: a data migration must describe the schema as it
is at THIS revision, and the models keep moving (indeed, this revision deletes
four of them).

Revision ID: b8f3d1c07a45
Revises: f4c81a92de70
Create Date: 2026-08-09
"""

from alembic import op
import sqlalchemy as sa

revision = "b8f3d1c07a45"
down_revision = "f4c81a92de70"
branch_labels = None
depends_on = None


THOUGHT_TAG = '["thought"]'
BATCH_TAG = '["thought-batch"]'

BATCH_EDGE = "converged_from_thought_batch"
THOUGHT_EDGE = "converged_from_thought"
REMINDER_EDGE = "converged_from_reminder"

# `d1a4c7f2b8e6`'s kind — READ as a matcher, never written by this migration.
LEGACY_REMINDER_EDGE = "migrated_from_reminder"

# Child-first: mentions and reminders both FK into thoughts, thoughts FKs into
# thought_batches. SQLite doesn't enforce FKs, but the order costs nothing and
# keeps the migration honest on a backend that does.
DROP_ORDER = ("mentions", "reminders", "thoughts", "thought_batches")


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


# ── upgrade ─────────────────────────────────────────────────────────────────


def upgrade():
    bind = op.get_bind()
    tables = _tables(bind)

    if "mentions" in tables:
        orphans = bind.execute(sa.text("SELECT COUNT(*) FROM mentions")).scalar() or 0
        if orphans:
            raise RuntimeError(
                f"`mentions` holds {orphans} row(s), but the convergence dropped it "
                "on the grounds that nothing ever wrote to it. Those rows have no "
                "v2 home and this migration would destroy them. Investigate before "
                "dropping — this is a data question, not a schema one."
            )

    # Provenance first — everything downgrade() needs has to be written while
    # the source rows are still readable.
    if "edges" in tables:
        if "thought_batches" in tables:
            _stamp_batches(bind)
        if "thoughts" in tables:
            _stamp_thoughts(bind)
        if "reminders" in tables and "promises" in tables:
            _stamp_reminders(bind)

    for table in DROP_ORDER:
        if table in tables:
            op.drop_table(table)


def _edge(bind, src_kind: str, src_id: int, dst_kind: str, dst_id: int, kind: str) -> None:
    """Write a provenance edge unless it's already there (UNIQUE 5-tuple)."""
    dup = bind.execute(
        sa.text(
            "SELECT 1 FROM edges WHERE src_kind = :sk AND src_id = :si "
            "AND dst_kind = :dk AND dst_id = :di AND kind = :k LIMIT 1"
        ),
        {"sk": src_kind, "si": src_id, "dk": dst_kind, "di": dst_id, "k": kind},
    ).scalar()
    if dup:
        return
    bind.execute(
        sa.text(
            "INSERT INTO edges (src_kind, src_id, dst_kind, dst_id, kind, created_at) "
            "VALUES (:sk, :si, :dk, :di, :k, CURRENT_TIMESTAMP)"
        ),
        {"sk": src_kind, "si": src_id, "dk": dst_kind, "di": dst_id, "k": kind},
    )


def _stamp_batches(bind) -> None:
    """thought_batch id → the note it became, matched exactly as the expand
    half created it: (tag, topic, started_at)."""
    rows = bind.execute(
        sa.text("SELECT id, topic_id, started_at FROM thought_batches ORDER BY id")
    ).fetchall()
    for r in rows:
        note_id = bind.execute(
            sa.text(
                "SELECT id FROM notes WHERE tags = :tag AND topic_id IS :topic "
                "AND created_at = :created LIMIT 1"
            ),
            {"tag": BATCH_TAG, "topic": r.topic_id, "created": r.started_at},
        ).scalar()
        if note_id:
            _edge(bind, "thought_batch", r.id, "note", note_id, BATCH_EDGE)


def _stamp_thoughts(bind) -> None:
    """thought id → its note, matched on (tag, timestamp, content)."""
    rows = bind.execute(
        sa.text("SELECT id, content, timestamp FROM thoughts ORDER BY id")
    ).fetchall()
    for r in rows:
        note_id = bind.execute(
            sa.text(
                "SELECT id FROM notes WHERE tags = :tag AND created_at = :created "
                "AND content = :content LIMIT 1"
            ),
            {"tag": THOUGHT_TAG, "created": r.timestamp, "content": r.content},
        ).scalar()
        if note_id:
            _edge(bind, "thought", r.id, "note", note_id, THOUGHT_EDGE)


def _stamp_reminders(bind) -> None:
    """reminder id → its promise. Same two-step matcher the expand half used:
    the 2026-08-01 copy's edge first (exact provenance survives text edits),
    then a text match for rows the connector wrote after it.

    The legacy kind is READ ONLY. Every resolved reminder — including one that
    already carries a `migrated_from_reminder` edge — is stamped under this
    migration's own kind, so `downgrade()` never has to consult a kind whose
    owner deletes promises on its way down.
    """
    prior: dict[int, int] = {}
    for src, dst in bind.execute(
        sa.text(
            "SELECT src_id, dst_id FROM edges WHERE kind = :k AND src_kind = 'reminder' "
            "AND dst_kind = 'promise' ORDER BY id"
        ),
        {"k": LEGACY_REMINDER_EDGE},
    ).fetchall():
        prior.setdefault(src, dst)

    rows = bind.execute(sa.text("SELECT id, content FROM reminders ORDER BY id")).fetchall()
    for r in rows:
        promise_id = prior.get(r.id)
        if promise_id is not None and not bind.execute(
            sa.text("SELECT 1 FROM promises WHERE id = :i"), {"i": promise_id}
        ).scalar():
            promise_id = None  # twin deleted since 2026-08-01 — fall through to text
        if promise_id is None:
            content = (r.content or "").strip()
            if not content:
                continue
            twin = bind.execute(
                sa.text(
                    "SELECT id FROM promises WHERE lower(trim(utterance)) = lower(:c) "
                    "ORDER BY (state = 'active') DESC, id ASC LIMIT 1"
                ),
                {"c": content.lower()},
            ).fetchone()
            promise_id = twin.id if twin else None
        if promise_id is not None:
            _edge(bind, "reminder", r.id, "promise", promise_id, REMINDER_EDGE)


# ── downgrade ───────────────────────────────────────────────────────────────


def downgrade():
    bind = op.get_bind()
    tables = _tables(bind)

    _recreate_tables(tables)

    if "edges" not in _tables(bind):
        return  # no provenance to walk — schema is back, rows can't be
    batch_map = _restore_batches(bind)
    thought_map = _restore_thoughts(bind, batch_map)
    _restore_reminders(bind, thought_map)


def _recreate_tables(tables: set[str]) -> None:
    """The four tables exactly as they stood at `f4c81a92de70` — i.e. the
    original `1aee2da7e158` shapes plus every column later migrations added
    (`thought_batches.image_url`, `reminders.state/resolved_at/due_is_default`)."""
    if "thought_batches" not in tables:
        op.create_table(
            "thought_batches",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("topic_id", sa.Integer(), nullable=False),
            sa.Column("label", sa.Text(), nullable=True),
            sa.Column("image_url", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("ended_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["topic_id"], ["topics.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_thought_batches_ended_at", "thought_batches", ["ended_at"], if_not_exists=True)
        op.create_index("ix_thought_batches_id", "thought_batches", ["id"], if_not_exists=True)
        op.create_index("ix_thought_batches_topic_id", "thought_batches", ["topic_id"], if_not_exists=True)

    if "thoughts" not in tables:
        op.create_table(
            "thoughts",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("timestamp", sa.DateTime(), nullable=False),
            sa.Column("batch_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["batch_id"], ["thought_batches.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_thoughts_batch_id", "thoughts", ["batch_id"], if_not_exists=True)
        op.create_index("ix_thoughts_id", "thoughts", ["id"], if_not_exists=True)
        op.create_index("ix_thoughts_timestamp", "thoughts", ["timestamp"], if_not_exists=True)

    if "mentions" not in tables:
        op.create_table(
            "mentions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("thought_id", sa.Integer(), nullable=False),
            sa.Column("person_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["person_id"], ["focus_people.id"]),
            sa.ForeignKeyConstraint(["thought_id"], ["thoughts.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("thought_id", "person_id", name="uq_mention_thought_person"),
        )
        op.create_index("ix_mentions_id", "mentions", ["id"], if_not_exists=True)
        op.create_index("ix_mentions_person_id", "mentions", ["person_id"], if_not_exists=True)
        op.create_index("ix_mentions_thought_id", "mentions", ["thought_id"], if_not_exists=True)

    if "reminders" not in tables:
        op.create_table(
            "reminders",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("content", sa.String(), nullable=False),
            sa.Column("owed_to", sa.Integer(), nullable=True),
            sa.Column("due_at", sa.DateTime(), nullable=True),
            sa.Column("due_is_default", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("state", sa.String(), nullable=False, server_default=sa.text("'active'")),
            sa.Column("resolved_at", sa.DateTime(), nullable=True),
            sa.Column("thought_id", sa.Integer(), nullable=True),
            sa.Column("parent_id", sa.Integer(), nullable=True),
            sa.Column("attachment_path", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["owed_to"], ["focus_people.id"]),
            sa.ForeignKeyConstraint(["parent_id"], ["reminders.id"]),
            sa.ForeignKeyConstraint(["thought_id"], ["thoughts.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        for col in (
            "created_at", "done", "due_at", "id", "owed_to", "parent_id",
            "state", "thought_id", "type",
        ):
            op.create_index(f"ix_reminders_{col}", "reminders", [col], if_not_exists=True)


def _provenance(bind, kind: str, src_kind: str, dst_kind: str) -> dict:
    """{source id → v2 id} from the edges upgrade() stamped."""
    rows = bind.execute(
        sa.text(
            "SELECT src_id, dst_id FROM edges WHERE kind = :k "
            "AND src_kind = :sk AND dst_kind = :dk ORDER BY id"
        ),
        {"k": kind, "sk": src_kind, "dk": dst_kind},
    ).fetchall()
    out: dict[int, int] = {}
    for src, dst in rows:
        out.setdefault(src, dst)
    return out


def _restore_batches(bind) -> dict:
    """Rebuild thought_batches from their notes. Returns {batch id → note id}."""
    mapping = _provenance(bind, BATCH_EDGE, "thought_batch", "note")
    for batch_id, note_id in mapping.items():
        if bind.execute(
            sa.text("SELECT 1 FROM thought_batches WHERE id = :i"), {"i": batch_id}
        ).scalar():
            continue
        note = bind.execute(
            sa.text(
                "SELECT id, title, topic_id, created_at, updated_at FROM notes WHERE id = :i"
            ),
            {"i": note_id},
        ).fetchone()
        # topic_id is NOT NULL on thought_batches; a note that lost its topic
        # can't be expressed as one. The note itself is untouched either way.
        if note is None or note.topic_id is None:
            continue
        image_url = bind.execute(
            sa.text(
                "SELECT public_url FROM attachments WHERE note_id = :n "
                "AND public_url IS NOT NULL ORDER BY id LIMIT 1"
            ),
            {"n": note_id},
        ).scalar()
        bind.execute(
            sa.text(
                "INSERT INTO thought_batches "
                "(id, topic_id, label, image_url, started_at, ended_at) "
                "VALUES (:i, :t, :l, :u, :s, :e)"
            ),
            {
                "i": batch_id,
                "t": note.topic_id,
                "l": note.title,
                "u": image_url,
                "s": note.created_at,
                "e": note.updated_at or note.created_at,
            },
        )
    return mapping


def _restore_thoughts(bind, batch_map: dict) -> dict:
    """Rebuild thoughts from their notes. Returns {thought id → note id}."""
    mapping = _provenance(bind, THOUGHT_EDGE, "thought", "note")
    note_to_batch = {note_id: batch_id for batch_id, note_id in batch_map.items()}
    for thought_id, note_id in mapping.items():
        if bind.execute(
            sa.text("SELECT 1 FROM thoughts WHERE id = :i"), {"i": thought_id}
        ).scalar():
            continue
        note = bind.execute(
            sa.text("SELECT content, created_at, parent_note_id FROM notes WHERE id = :i"),
            {"i": note_id},
        ).fetchone()
        if note is None:
            continue
        batch_id = note_to_batch.get(note.parent_note_id)
        # batch_id is NOT NULL — a thought whose batch we can't name is one the
        # old schema had no way to hold.
        if batch_id is None or not bind.execute(
            sa.text("SELECT 1 FROM thought_batches WHERE id = :i"), {"i": batch_id}
        ).scalar():
            continue
        bind.execute(
            sa.text(
                "INSERT INTO thoughts (id, content, timestamp, batch_id) "
                "VALUES (:i, :c, :t, :b)"
            ),
            {"i": thought_id, "c": note.content, "t": note.created_at, "b": batch_id},
        )
    return mapping


def _restore_reminders(bind, thought_map: dict) -> None:
    """Rebuild reminders from their promises.

    `type` is re-derived from `owed_to` — the same rule `focus_service` applies
    now that Promise is the store. An `is_promise=True` row owed to nobody comes
    back as a plain reminder; that distinction stopped existing when the type
    column stopped being read, and inventing it back would be a fiction.
    """
    mapping = _provenance(bind, REMINDER_EDGE, "reminder", "promise")
    note_to_thought = {note_id: tid for tid, note_id in thought_map.items()}
    for reminder_id, promise_id in mapping.items():
        if bind.execute(
            sa.text("SELECT 1 FROM reminders WHERE id = :i"), {"i": reminder_id}
        ).scalar():
            continue
        p = bind.execute(
            sa.text(
                "SELECT id, utterance, owed_to, inferred_due, due_is_default, state, "
                "       resolved_at, created_at FROM promises WHERE id = :i"
            ),
            {"i": promise_id},
        ).fetchone()
        if p is None:
            continue  # promise deleted since the drop — nothing to rebuild from

        # reminders.thought_id came back as a `derives_from` promise → note edge.
        thought_id = None
        derived = bind.execute(
            sa.text(
                "SELECT dst_id FROM edges WHERE kind = 'derives_from' "
                "AND src_kind = 'promise' AND src_id = :p AND dst_kind = 'note' "
                "ORDER BY id LIMIT 1"
            ),
            {"p": promise_id},
        ).scalar()
        if derived is not None:
            candidate = note_to_thought.get(derived)
            if candidate and bind.execute(
                sa.text("SELECT 1 FROM thoughts WHERE id = :i"), {"i": candidate}
            ).scalar():
                thought_id = candidate

        state = p.state or "active"
        bind.execute(
            sa.text(
                "INSERT INTO reminders "
                "(id, type, content, owed_to, due_at, due_is_default, done, state, "
                " resolved_at, thought_id, parent_id, attachment_path, created_at) "
                "VALUES (:i, :ty, :c, :o, :d, :dflt, :done, :st, :res, :th, NULL, NULL, :cr)"
            ),
            {
                "i": reminder_id,
                "ty": "promise" if p.owed_to is not None else "reminder",
                "c": p.utterance,
                "o": p.owed_to,
                "d": p.inferred_due,
                "dflt": 1 if p.due_is_default else 0,
                "done": 0 if state == "active" else 1,
                "st": state,
                "res": p.resolved_at,
                "th": thought_id,
                "cr": p.created_at,
            },
        )
