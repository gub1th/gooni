"""Drop the converged focus tables (CONTRACT half).

`f4c81a92de70` was the EXPAND half: it backfilled `thought_batches`, `thoughts`
and `reminders` into Notes/Promises and deliberately left all four source tables
(those three plus `mentions`) in place, unread, so the backfill could be diffed
in prod. This is the contract half — it drops them.

**RUN `scripts/verify_focus_convergence.py` AGAINST THE TARGET DATABASE AND GET A
ZERO EXIT BEFORE DEPLOYING THIS REVISION. It is the only gate.** The drop here is
UNCONDITIONAL: `upgrade()` stamps provenance and then drops the four tables, with
no per-row check that would refuse. A source row the expand half never absorbed is
destroyed, and `downgrade()` cannot bring it back — it has no edge to walk. Every
such row is logged at WARNING as `upgrade()` passes over it, with a closing
per-table tally before the drops run. That log is reporting, never a refusal —
but once the table is gone it is the only record of what was lost, which is
exactly the state an operator who skipped the verifier ends up in.

A ROLLBACK CAN COME BACK PARTIAL, and not only in that no-edge-at-all case. An
edge can survive while the v2 row it points at does not, or survives in a shape
the old schema can't hold, and then that source row is skipped too. This is
ordinary, not exotic: `thought-batch` notes are NOT hidden from the notes browser
(`app/routers/notes.py`'s `_BROWSE_HIDDEN_TAG` LIKE pattern for `"thought"` does
not match the `"thought-batch"` tag), and `delete_note` does no Edge cleanup, so
deleting one batch note through the UI strands that batch's provenance — and with
it every thought under the batch, since `thoughts.batch_id` is NOT NULL. Skipped
rows are logged at WARNING, per row and as a closing per-table tally.

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

`downgrade()` walks those edges backwards and rebuilds each row FOR WHICH AN
ACCEPTABLE CANDIDATE SURVIVES — original ids included, which is what lets
`reminders.thought_id` and `thoughts.batch_id` be restored as real foreign keys
rather than dangling integers. Acceptable means the restore could actually build
a row the OLD schema accepts: each rebuild assembles its full row and checks it
against that table's NOT NULL columns (`NOT_NULL_COLUMNS`, mirrored from
`_recreate_tables`) before inserting, so a destination that survived but drifted
— a note that lost its topic, or whose content was emptied — rejects and falls
through to the next stamp. The rest are skipped and reported; see the partial
-rollback note above.

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

import logging

from alembic import op
import sqlalchemy as sa

revision = "b8f3d1c07a45"
down_revision = "f4c81a92de70"
branch_labels = None
depends_on = None

# `alembic` qualname → inherits the console handler alembic.ini already wires up,
# so a skipped row surfaces wherever the migration runs, boot included.
log = logging.getLogger(f"alembic.migration.{revision}")

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
    unstamped: dict[str, list[int]] = {}
    if "edges" in tables:
        if "thought_batches" in tables:
            _stamp_batches(bind, unstamped)
        if "thoughts" in tables:
            _stamp_thoughts(bind, unstamped)
        if "reminders" in tables:
            if "promises" in tables:
                _stamp_reminders(bind, unstamped)
            else:
                _unstampable(bind, unstamped, "reminders", "`promises` is absent, so no reminder can be matched to a twin")
    else:
        for table in ("thought_batches", "thoughts", "reminders"):
            if table in tables:
                _unstampable(bind, unstamped, table, "`edges` is absent, so no provenance can be recorded at all")

    if unstamped:
        log.warning(
            "the drop below DESTROYS these source rows: no v2 destination could be "
            "resolved for them, so no provenance edge was stamped and downgrade() "
            "has nothing to walk back — %s",
            ", ".join(f"{t}: {len(ids)} ({ids})" for t, ids in sorted(unstamped.items())),
        )

    for table in DROP_ORDER:
        if table in tables:
            op.drop_table(table)


def _unstamped(tally: dict, table: str, src_id: int, reason: str) -> None:
    """Report one source row the drop is about to destroy unrecoverably.

    Reporting only — the drop stays unconditional by design, because the
    discriminator a refusal would need cannot work uniformly (a reminder deleted
    through the dashboard legitimately has neither twin nor provenance, and a
    guard keying on that would refuse to boot forever). `verify_focus_convergence.py`
    is the gate; this is the forensic trail for the deploy that skipped it.
    """
    log.warning(
        "%s id %s has NO v2 destination (%s). The drop is unconditional, so this "
        "row is destroyed here and downgrade() cannot rebuild it — there is no "
        "provenance edge to walk. scripts/verify_focus_convergence.py catches this "
        "while the row still exists; run it against the target DB before deploying.",
        table,
        src_id,
        reason,
    )
    tally.setdefault(table, []).append(src_id)


def _unstampable(bind, tally: dict, table: str, reason: str) -> None:
    """Whole-table variant: the matcher can't run, so every row is unstamped."""
    rows = bind.execute(sa.text(f"SELECT id FROM {table} ORDER BY id")).fetchall()
    for r in rows:
        _unstamped(tally, table, r.id, reason)


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


def _stamp_batches(bind, tally: dict) -> None:
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
        else:
            _unstamped(
                tally,
                "thought_batches",
                r.id,
                "no `thought-batch` note carries its (topic_id, started_at)",
            )


def _stamp_thoughts(bind, tally: dict) -> None:
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
        else:
            _unstamped(
                tally,
                "thoughts",
                r.id,
                "no `thought` note carries its (timestamp, content)",
            )


def _stamp_reminders(bind, tally: dict) -> None:
    """reminder id → its promise. Same two-step matcher the expand half used:
    the 2026-08-01 copy's edge first (exact provenance survives text edits),
    then a text match for rows the connector wrote after it.

    The legacy kind is READ ONLY. Every resolved reminder — including one that
    already carries a `migrated_from_reminder` edge — is stamped under this
    migration's own kind, so `downgrade()` never has to consult a kind whose
    owner deletes promises on its way down.

    THE TEXT PREDICATE BELOW IS CHARACTER-FOR-CHARACTER THE GATE'S. It has to
    be: `scripts/verify_focus_convergence.py` asks `lower(trim(p.utterance)) =
    lower(trim(r.content))`, and a row it calls accounted for that this matcher
    then misses is dropped with no provenance and no way back — the one outcome
    the sole-gate design can't absorb. So both sides go through SQLite's
    `lower()` and both through `trim()`; nothing is pre-folded in Python, whose
    `.lower()` is full-Unicode where SQLite's is ASCII-only (they disagree on
    the first uppercase non-ASCII character either side). Editing one predicate
    without the other reopens that gap.
    """
    prior = _provenance(bind, LEGACY_REMINDER_EDGE, "reminder", "promise")

    rows = bind.execute(sa.text("SELECT id, content FROM reminders ORDER BY id")).fetchall()
    for r in rows:
        # A twin deleted since 2026-08-01 falls through to the text match.
        promise_id = _resolve(prior.get(r.id, ()), lambda p: _live_promise(bind, p))
        if promise_id is None:
            content = (r.content or "").strip()
            if not content:
                _unstamped(
                    tally,
                    "reminders",
                    r.id,
                    "its content is empty, so the text matcher has nothing to match "
                    "on, and no live `migrated_from_reminder` twin names it",
                )
                continue
            twin = bind.execute(
                sa.text(
                    "SELECT id FROM promises WHERE lower(trim(utterance)) = lower(trim(:c)) "
                    "ORDER BY (state = 'active') DESC, id ASC LIMIT 1"
                ),
                {"c": r.content},
            ).fetchone()
            promise_id = twin.id if twin else None
        if promise_id is not None:
            _edge(bind, "reminder", r.id, "promise", promise_id, REMINDER_EDGE)
        else:
            _unstamped(
                tally,
                "reminders",
                r.id,
                "no promise carries its content as an utterance, and no live "
                "`migrated_from_reminder` twin names it",
            )


# ── downgrade ───────────────────────────────────────────────────────────────


def downgrade():
    bind = op.get_bind()
    tables = _tables(bind)

    _recreate_tables(tables)

    if "edges" not in _tables(bind):
        return  # no provenance to walk — schema is back, rows can't be
    tally: dict[str, list[int]] = {}
    note_to_batch = _restore_batches(bind, tally)
    note_to_thought = _restore_thoughts(bind, note_to_batch, tally)
    _restore_reminders(bind, note_to_thought, tally)
    if tally:
        log.warning(
            "downgrade restored what the surviving provenance allowed; these rows "
            "could NOT be rebuilt and are missing from the restored tables — %s",
            ", ".join(f"{t}: {len(ids)} ({ids})" for t, ids in sorted(tally.items())),
        )


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


# Every NOT NULL column of each restored table, mirrored from the
# `create_table` calls above — the columns without `nullable=True` and without a
# `server_default` the INSERT relies on. Restores name every column they write,
# so a column added to `_recreate_tables` is checked here by NAME rather than by
# whoever remembers to hand-write a guard for it. Nullable and therefore absent:
# thought_batches.label/image_url, reminders.owed_to/due_at/resolved_at/
# thought_id/parent_id/attachment_path.
NOT_NULL_COLUMNS = {
    "thought_batches": ("id", "topic_id", "started_at", "ended_at"),
    "thoughts": ("id", "content", "timestamp", "batch_id"),
    "reminders": ("id", "type", "content", "due_is_default", "done", "state", "created_at"),
}


def _rebuildable(table: str, row: dict) -> bool:
    """Can this candidate's rebuilt row actually satisfy the old schema?

    The v2 side is looser than the focus side was — `notes.content`,
    `notes.created_at` and `notes.topic_id` are all nullable, and the first two
    are reachable through the ordinary notes API — so a destination that survived
    the drop can still be unexpressible as the row it came from. Checking the
    assembled row against the destination's NOT NULL columns is what makes the
    candidate walk reject it and try the next stamp, instead of the INSERT
    raising and taking the whole rollback down with it.
    """
    missing = [c for c in NOT_NULL_COLUMNS[table] if row.get(c) is None]
    if missing:
        log.info(
            "%s id %s: candidate rejected — %s would be NULL on a NOT NULL column",
            table,
            row.get("id"),
            ", ".join(missing),
        )
        return False
    return True


def _provenance(bind, kind: str, src_kind: str, dst_kind: str) -> dict:
    """{source id → [v2 id, …]} from the edges upgrade() stamped, oldest first.

    A source id can carry more than one edge: `_edge` dedups on the 5-tuple, so a
    down-then-up cycle that lands the source on a NEW v2 row adds a second edge
    beside the first rather than replacing it — and the first may now point at a
    row that is gone, or at one that survived but can no longer satisfy the old
    schema. Callers walk the list through `_resolve`, so neither kind of dead
    stamp shadows a usable one. Stamp order is the tiebreak among the candidates
    that do work, so repeated downgrades rebuild identically.
    """
    rows = bind.execute(
        sa.text(
            "SELECT src_id, dst_id FROM edges WHERE kind = :k "
            "AND src_kind = :sk AND dst_kind = :dk ORDER BY id"
        ),
        {"k": kind, "sk": src_kind, "dk": dst_kind},
    ).fetchall()
    out: dict[int, list[int]] = {}
    for src, dst in rows:
        bucket = out.setdefault(src, [])
        if dst not in bucket:
            bucket.append(dst)
    return out


NOTE_SQL = "SELECT id, title, content, topic_id, parent_note_id, created_at, updated_at FROM notes WHERE id = :i"
PROMISE_SQL = (
    "SELECT id, utterance, owed_to, inferred_due, due_is_default, state, "
    "       resolved_at, created_at FROM promises WHERE id = :i"
)
PROMISE_EXISTS_SQL = "SELECT id FROM promises WHERE id = :i"


def _live_promise(bind, promise_id: int) -> int | None:
    exists = bind.execute(sa.text(PROMISE_EXISTS_SQL), {"i": promise_id}).scalar()
    return promise_id if exists else None


def _resolve(candidates, attempt):
    """Walk the stamped candidates in order; the first the caller can actually
    rebuild from wins.

    The accept test is the caller's OWN validity guards, not bare row existence:
    a destination that survived can still be unusable (a note that lost its topic
    can't satisfy `thought_batches.topic_id NOT NULL`), and rejecting it must fall
    through to the next stamp rather than strand the source row. `attempt` returns
    None to reject. None when every candidate is rejected — that case is genuinely
    unrecoverable, so the caller reports it and moves on rather than raising; this
    runs at boot and a rollback that stops halfway is worse than a partial one.
    """
    for dst_id in candidates:
        got = attempt(dst_id)
        if got is not None:
            return got
    return None


def _skipped(tally: dict, table: str, src_id: int, reason: str = "") -> None:
    log.warning(
        "%s id %s NOT rebuilt: %s. The row is absent from the restored table.",
        table,
        src_id,
        reason
        or (
            "every stamped provenance candidate was rejected — its v2 destination "
            "is gone, or survives in a shape the old schema can't hold"
        ),
    )
    tally.setdefault(table, []).append(src_id)


def _restore_row(tally: dict, table: str, src_id: int, candidates, attempt):
    """Rebuild one source row, containing every failure to that row.

    Partial is the contract: a row that can't come back is skipped and reported,
    never raised on. That has to hold for the unforeseen failure too — an
    exception escaping here would abort the rollback mid-pass, leaving some
    tables rebuilt, the rest not, and the version stamp unmoved, which is strictly
    worse than coming back short. So one bad row costs itself and nothing else,
    with the exception detail on the same WARNING channel as an ordinary skip so
    it stays diagnosable. The containment is per row, not around the pass, so a
    systemic failure still shows up once per row rather than being swallowed once.
    """
    try:
        rebuilt = _resolve(candidates, attempt)
    except Exception as exc:
        _skipped(tally, table, src_id, f"rebuilding it raised {type(exc).__name__}: {exc}")
        return None
    if rebuilt is None:
        _skipped(tally, table, src_id)
    return rebuilt


def _restore_batches(bind, tally: dict) -> dict:
    """Rebuild thought_batches from their notes. Returns {note id → batch id} for
    EVERY note a batch was stamped at — a thought still parented to a supplanted
    batch note has to be able to name its batch too."""
    note_to_batch: dict[int, int] = {}
    for batch_id, candidates in _provenance(bind, BATCH_EDGE, "thought_batch", "note").items():
        for note_id in candidates:
            note_to_batch.setdefault(note_id, batch_id)
        if bind.execute(
            sa.text("SELECT 1 FROM thought_batches WHERE id = :i"), {"i": batch_id}
        ).scalar():
            continue
        _restore_row(
            tally,
            "thought_batches",
            batch_id,
            candidates,
            lambda n, b=batch_id: _rebuild_batch(bind, b, n),
        )
    return note_to_batch


def _rebuild_batch(bind, batch_id: int, note_id: int) -> int | None:
    note = bind.execute(sa.text(NOTE_SQL), {"i": note_id}).fetchone()
    if note is None:
        return None
    image_url = bind.execute(
        sa.text(
            "SELECT public_url FROM attachments WHERE note_id = :n "
            "AND public_url IS NOT NULL ORDER BY id LIMIT 1"
        ),
        {"n": note.id},
    ).scalar()
    row = {
        "id": batch_id,
        "topic_id": note.topic_id,
        "label": note.title,
        "image_url": image_url,
        "started_at": note.created_at,
        "ended_at": note.updated_at or note.created_at,
    }
    if not _rebuildable("thought_batches", row):
        return None
    bind.execute(
        sa.text(
            "INSERT INTO thought_batches "
            "(id, topic_id, label, image_url, started_at, ended_at) "
            "VALUES (:id, :topic_id, :label, :image_url, :started_at, :ended_at)"
        ),
        row,
    )
    return note_id


def _restore_thoughts(bind, note_to_batch: dict, tally: dict) -> dict:
    """Rebuild thoughts from their notes. Returns {note id → thought id}."""
    note_to_thought: dict[int, int] = {}
    for thought_id, candidates in _provenance(bind, THOUGHT_EDGE, "thought", "note").items():
        for note_id in candidates:
            note_to_thought.setdefault(note_id, thought_id)
        if bind.execute(
            sa.text("SELECT 1 FROM thoughts WHERE id = :i"), {"i": thought_id}
        ).scalar():
            continue
        _restore_row(
            tally,
            "thoughts",
            thought_id,
            candidates,
            lambda n, t=thought_id: _rebuild_thought(bind, t, n, note_to_batch),
        )
    return note_to_thought


def _rebuild_thought(bind, thought_id: int, note_id: int, note_to_batch: dict) -> int | None:
    note = bind.execute(sa.text(NOTE_SQL), {"i": note_id}).fetchone()
    if note is None:
        return None
    batch_id = note_to_batch.get(note.parent_note_id)
    # A named batch that isn't in the rebuilt table is as unusable as no batch at
    # all — the NOT NULL check can't see that, so it stays a separate guard.
    if batch_id is not None and not bind.execute(
        sa.text("SELECT 1 FROM thought_batches WHERE id = :i"), {"i": batch_id}
    ).scalar():
        batch_id = None
    row = {
        "id": thought_id,
        "content": note.content,
        "timestamp": note.created_at,
        "batch_id": batch_id,
    }
    if not _rebuildable("thoughts", row):
        return None
    bind.execute(
        sa.text(
            "INSERT INTO thoughts (id, content, timestamp, batch_id) "
            "VALUES (:id, :content, :timestamp, :batch_id)"
        ),
        row,
    )
    return note_id


def _restore_reminders(bind, note_to_thought: dict, tally: dict) -> None:
    """Rebuild reminders from their promises."""
    for reminder_id, candidates in _provenance(bind, REMINDER_EDGE, "reminder", "promise").items():
        if bind.execute(
            sa.text("SELECT 1 FROM reminders WHERE id = :i"), {"i": reminder_id}
        ).scalar():
            continue
        _restore_row(
            tally,
            "reminders",
            reminder_id,
            candidates,
            lambda p, r=reminder_id: _rebuild_reminder(bind, r, p, note_to_thought),
        )


def _rebuild_reminder(bind, reminder_id: int, promise_id: int, note_to_thought: dict) -> int | None:
    """`type` is re-derived from `owed_to` — the same rule `focus_service` applies
    now that Promise is the store. An `is_promise=True` row owed to nobody comes
    back as a plain reminder; that distinction stopped existing when the type
    column stopped being read, and inventing it back would be a fiction.
    """
    p = bind.execute(sa.text(PROMISE_SQL), {"i": promise_id}).fetchone()
    if p is None:
        return None  # twin deleted since the drop — try the next stamp

    # reminders.thought_id came back as a `derives_from` promise → note edge.
    thought_id = None
    derived = bind.execute(
        sa.text(
            "SELECT dst_id FROM edges WHERE kind = 'derives_from' "
            "AND src_kind = 'promise' AND src_id = :p AND dst_kind = 'note' "
            "ORDER BY id LIMIT 1"
        ),
        {"p": p.id},
    ).scalar()
    if derived is not None:
        candidate = note_to_thought.get(derived)
        if candidate and bind.execute(
            sa.text("SELECT 1 FROM thoughts WHERE id = :i"), {"i": candidate}
        ).scalar():
            thought_id = candidate

    state = p.state or "active"
    row = {
        "id": reminder_id,
        "type": "promise" if p.owed_to is not None else "reminder",
        "content": p.utterance,
        "owed_to": p.owed_to,
        "due_at": p.inferred_due,
        "due_is_default": 1 if p.due_is_default else 0,
        "done": 0 if state == "active" else 1,
        "state": state,
        "resolved_at": p.resolved_at,
        "thought_id": thought_id,
        "created_at": p.created_at,
    }
    if not _rebuildable("reminders", row):
        return None
    bind.execute(
        sa.text(
            "INSERT INTO reminders "
            "(id, type, content, owed_to, due_at, due_is_default, done, state, "
            " resolved_at, thought_id, parent_id, attachment_path, created_at) "
            "VALUES (:id, :type, :content, :owed_to, :due_at, :due_is_default, "
            " :done, :state, :resolved_at, :thought_id, NULL, NULL, :created_at)"
        ),
        row,
    )
    return promise_id
