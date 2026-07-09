"""trackables + trackable_entries; migrate daily_metrics history

Ambient-loop v2 Slice 2. Creates the generic measurement primitive and
copies every DailyMetric row into TrackableEntry so cut history (mid-cut,
start 2026-04-02) survives the primitive collapse. daily_metrics table
stays in place (dead weight) until the Slice 6 nuke sweep.

Revision ID: f3b8d1c6a9e2
Revises: e7a2c9b1d4f8
Create Date: 2026-07-08
"""

import json

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "f3b8d1c6a9e2"
down_revision = "e7a2c9b1d4f8"
branch_labels = None
depends_on = None


# The system trackables DailyMetric's hardcoded vocabulary maps onto.
# (name, kind, unit, agg)
_SYSTEM_TRACKABLES = [
    ("calories", "numeric", "kcal", "sum"),
    ("protein", "numeric", "g", "sum"),
    ("weight", "numeric", "lb", "last"),
    ("exercise", "boolean", None, "last"),
    ("alcohol", "boolean", None, "last"),
    ("weed", "boolean", None, "last"),
    ("vape", "boolean", None, "last"),
    ("note", "json", None, "last"),
]


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("trackables"):
        op.create_table(
            "trackables",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False, server_default="numeric"),
            sa.Column("unit", sa.String(), nullable=True),
            sa.Column("cadence", sa.String(), nullable=True),
            sa.Column("target", sa.Float(), nullable=True),
            sa.Column(
                "is_important",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("agg", sa.String(), nullable=False, server_default="last"),
            sa.Column("schema_hint", sa.Text(), nullable=True),
            sa.Column("source", sa.String(), nullable=False, server_default="manual"),
            sa.Column(
                "parent_promise_id",
                sa.Integer(),
                sa.ForeignKey("promises.id"),
                nullable=True,
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )
        op.create_index("ix_trackables_id", "trackables", ["id"], if_not_exists=True)
        op.create_index(
            "ix_trackables_name", "trackables", ["name"], unique=True, if_not_exists=True
        )
        op.create_index(
            "ix_trackables_parent_promise_id",
            "trackables",
            ["parent_promise_id"],
            if_not_exists=True,
        )

    if not inspector.has_table("trackable_entries"):
        op.create_table(
            "trackable_entries",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "trackable_id",
                sa.Integer(),
                sa.ForeignKey("trackables.id"),
                nullable=False,
            ),
            sa.Column("date", sa.Date(), nullable=False),
            sa.Column("value_boolean", sa.Boolean(), nullable=True),
            sa.Column("value_numeric", sa.Float(), nullable=True),
            sa.Column("value_json", sa.Text(), nullable=True),
            sa.Column("source", sa.String(), nullable=False, server_default="manual"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index(
            "ix_trackable_entries_id", "trackable_entries", ["id"], if_not_exists=True
        )
        op.create_index(
            "ix_trackable_entries_trackable_id",
            "trackable_entries",
            ["trackable_id"],
            if_not_exists=True,
        )
        op.create_index(
            "ix_trackable_entries_date",
            "trackable_entries",
            ["date"],
            if_not_exists=True,
        )
        op.create_index(
            "ix_trackable_entries_tid_date",
            "trackable_entries",
            ["trackable_id", "date"],
            if_not_exists=True,
        )

    # ── Seed system trackables (idempotent by unique name) ──────────────
    now = sa.text("CURRENT_TIMESTAMP")
    ids: dict[str, int] = {}
    for name, kind, unit, agg in _SYSTEM_TRACKABLES:
        row = bind.execute(
            sa.text("SELECT id FROM trackables WHERE name = :n"), {"n": name}
        ).fetchone()
        if row is None:
            bind.execute(
                sa.text(
                    "INSERT INTO trackables "
                    "(name, kind, unit, agg, is_important, source, created_at, updated_at) "
                    "VALUES (:n, :k, :u, :a, 0, 'chat', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"n": name, "k": kind, "u": unit, "a": agg},
            )
            row = bind.execute(
                sa.text("SELECT id FROM trackables WHERE name = :n"), {"n": name}
            ).fetchone()
        ids[name] = row[0]

    # Best-effort: carry cut-config limits onto the definitions.
    try:
        s = bind.execute(
            sa.text("SELECT cut_calorie_limit, cut_protein_limit FROM settings LIMIT 1")
        ).fetchone()
        if s is not None:
            if s[0] is not None:
                bind.execute(
                    sa.text("UPDATE trackables SET target = :t WHERE id = :i"),
                    {"t": float(s[0]), "i": ids["calories"]},
                )
            if s[1] is not None:
                bind.execute(
                    sa.text("UPDATE trackables SET target = :t WHERE id = :i"),
                    {"t": float(s[1]), "i": ids["protein"]},
                )
    except Exception:
        pass  # settings table/cols may not exist on a fresh walk

    # ── Copy daily_metrics history → trackable_entries (idempotent:  ────
    # skip if any migrated rows already exist).
    if not inspector.has_table("daily_metrics"):
        return
    already = bind.execute(
        sa.text("SELECT COUNT(*) FROM trackable_entries WHERE source = 'migration'")
    ).fetchone()[0]
    if already:
        return

    rows = bind.execute(
        sa.text(
            "SELECT metric_type, value, unit, date, notes, created_at "
            "FROM daily_metrics ORDER BY created_at ASC, id ASC"
        )
    ).fetchall()
    for metric_type, value, unit, day, notes, created_at in rows:
        tid = ids.get(metric_type)
        if tid is None:
            continue  # unknown free-string type — nothing to map onto
        vb = None
        vn = None
        vj: dict = {}
        if metric_type in ("calories", "protein", "weight"):
            vn = float(value or 0)
            if notes:
                vj["label"] = notes
            if unit:
                vj["unit"] = unit
        elif metric_type in ("alcohol", "weed", "vape", "exercise"):
            vb = bool(value and float(value) > 0)
            if notes:
                vj["label"] = notes
        elif metric_type == "note":
            vj["text"] = notes or ""
        bind.execute(
            sa.text(
                "INSERT INTO trackable_entries "
                "(trackable_id, date, value_boolean, value_numeric, value_json, source, created_at) "
                "VALUES (:tid, :d, :vb, :vn, :vj, 'migration', :ca)"
            ),
            {
                "tid": tid,
                "d": day,
                "vb": vb,
                "vn": vn,
                "vj": json.dumps(vj) if vj else None,
                "ca": created_at,
            },
        )


def downgrade():
    op.drop_table("trackable_entries")
    op.drop_table("trackables")
