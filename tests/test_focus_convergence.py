"""Net for the focus→v2 convergence (`f4c81a92de70` + `b8f3d1c07a45`).

Three halves, all against a throwaway SQLite built by the REAL migration chain
(no fixtures hand-rolled from models — a data migration has to be tested
against the schema it actually runs on):

  1. EXPAND — seeds the situation prod was actually in on 2026-08-08:
     `d1a4c7f2b8e6` had already copied reminders into promises and left both
     tables live, so the rows drifted. Asserts the backfill adopts twins rather
     than duplicating them, repairs what that earlier copy had to drop
     (`owed_to` folded into a summary prefix, defaulted dues nulled), and
     leaves the source tables standing.

  2. CONTRACT — the drop. Asserts the four tables are gone, that a provenance
     edge was stamped for every source row first, and that `downgrade()` walks
     those edges back to rebuild each row with its ORIGINAL id — the property
     that makes dropping production tables reversible — plus the reason those
     edges carry their own `converged_from_*` kinds: a rollback through
     `d1a4c7f2b8e6` must not delete a promise that migration never inserted.
     Both directions are also asserted to REPORT rather than refuse: a v2 row
     that drifted out of the old schema's reach costs its own row and not the
     rollback, and a source row the drop destroys unrecoverably is named in the
     log before the table is gone. And because the drop is unconditional, the
     migration is asserted to match every twin `verify_focus_convergence.py`
     counted — the gate clearing a row the migration then misses is the one
     failure the sole-gate design has no answer for.

  3. ADAPTER — focus_service now writes Notes and Promises. Asserts the batch
     rule, the `at` backdate, and that the dashboard payload keeps every key
     the kiosk and FocusDashboard read.

Run: python tests/test_focus_convergence.py   (no LLM, no network)
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

PRE_REVISION = "d1a4c7f2b8e6"  # the reminders→promises copy, before convergence
BELOW_PRE_REVISION = "b6e4c2a9d713"  # one below it — downgrading here runs its downgrade()
EXPAND_REVISION = "f4c81a92de70"  # backfill; source tables still standing
CONTRACT_REVISION = "b8f3d1c07a45"  # the drop
SOURCE_TABLES = ("thoughts", "thought_batches", "reminders", "mentions")

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def check_true(label: str, got) -> None:
    check(label, bool(got), True)


def _alembic(db_path: str, rev: str, direction: str = "upgrade") -> None:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"}
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", direction, rev],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"alembic {direction} {rev} failed:\n{proc.stdout}\n{proc.stderr}")


# ── seed: the shape prod was in before convergence ───────────────────────────

SEED = """
INSERT INTO topics (id,name,parent_id,salience,last_touched,color,created_at)
  VALUES (1,'Gooni',NULL,0.5,'2026-08-01 10:00:00','#AFA9EC','2026-07-01 10:00:00');
INSERT INTO focus_people (id,name,context,first_seen)
  VALUES (1,'Yash','CMU club tennis','2026-07-01 10:00:00');

INSERT INTO thought_batches (id,topic_id,label,image_url,started_at,ended_at)
  VALUES (1,1,'Gooni decided the store stays dumb.',NULL,
          '2026-08-01 10:00:00','2026-08-01 10:20:00'),
         (2,1,'Gooni pinned the whiteboard.',
          'https://pub-abc.r2.dev/images/2026/08/01/xy.png',
          '2026-08-01 12:00:00','2026-08-01 12:00:00');
INSERT INTO thoughts (id,content,timestamp,batch_id)
  VALUES (1,'the store should stay dumb','2026-08-01 10:05:00',1),
         (2,'claude does the thinking','2026-08-01 10:15:00',1);

-- R1: copied by d1a4c7f2b8e6 (edge provenance). That copy folded owed_to into
-- the summary and NULLed the defaulted due.
INSERT INTO reminders (id,type,content,owed_to,due_at,due_is_default,done,state,
                       resolved_at,thought_id,created_at)
  VALUES (1,'promise','Get plants for the new place',1,'2026-08-09 06:59:00',1,0,
          'active',NULL,1,'2026-08-01 10:30:00');
INSERT INTO promises (id,cadence,is_important,utterance,summary,inferred_due,state,
                      needs_clarification,slip_count,created_at,updated_at)
  VALUES (1,'once',0,'Get plants for the new place',
          'owed to Yash: Get plants for the new place',NULL,'active',1,0,
          '2026-08-01 10:30:00','2026-08-01 10:30:00');
INSERT INTO edges (src_kind,src_id,dst_kind,dst_id,kind,created_at)
  VALUES ('reminder',1,'promise',1,'migrated_from_reminder','2026-08-01 11:00:00');

-- R2: written by the connector AFTER that migration — no edge, text match only.
INSERT INTO reminders (id,type,content,owed_to,due_at,due_is_default,done,state,
                       resolved_at,thought_id,created_at)
  VALUES (2,'reminder','Write down goals',NULL,'2026-08-09 06:59:00',1,0,'active',
          NULL,NULL,'2026-08-03 10:30:00');
INSERT INTO promises (id,cadence,is_important,utterance,summary,inferred_due,state,
                      needs_clarification,slip_count,created_at,updated_at)
  VALUES (2,'once',0,'Write down goals','Write down goals','2026-08-09 06:59:00',
          'active',0,0,'2026-08-03 10:31:00','2026-08-03 10:31:00');

-- R3: genuinely new, no twin anywhere.
INSERT INTO reminders (id,type,content,owed_to,due_at,due_is_default,done,state,
                       resolved_at,thought_id,created_at)
  VALUES (3,'reminder','Study system design',NULL,'2026-08-15 06:59:00',0,0,'active',
          NULL,2,'2026-08-05 10:30:00');
"""


def test_migration(db_path: str) -> None:
    import sqlite3

    _alembic(db_path, PRE_REVISION)
    conn = sqlite3.connect(db_path)
    conn.executescript(SEED)
    conn.commit()
    conn.close()

    _alembic(db_path, EXPAND_REVISION)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731

    print("\n[migration] thoughts + batches → notes")
    check("batch notes", q("""select count(*) n from notes where tags='["thought-batch"]'""")[0]["n"], 2)
    check("thought notes", q("""select count(*) n from notes where tags='["thought"]'""")[0]["n"], 2)
    check(
        "thoughts parented to their batch",
        q("""select count(*) n from notes where tags='["thought"]' and parent_note_id is not null""")[0]["n"],
        2,
    )
    check(
        "thoughts carry the topic FK",
        q("""select count(*) n from notes where tags='["thought"]' and topic_id=1""")[0]["n"],
        2,
    )
    check("batch image → attachment", q("select count(*) n from attachments")[0]["n"], 1)

    print("[migration] reminders → promises, no duplication")
    check("total promises", q("select count(*) n from promises")[0]["n"], 3)
    check("edge-matched twin not duplicated", q("select count(*) n from promises where utterance like 'Get plants%'")[0]["n"], 1)
    check("text-matched twin not duplicated", q("select count(*) n from promises where utterance='Write down goals'")[0]["n"], 1)
    check("genuinely-new reminder inserted", q("select count(*) n from promises where utterance='Study system design'")[0]["n"], 1)

    print("[migration] repair of what the 2026-08-01 copy dropped")
    r1 = q("select * from promises where id=1")[0]
    check("owed_to restored", r1["owed_to"], 1)
    check("summary prefix stripped", r1["summary"], "Get plants for the new place")
    check("defaulted due restored", r1["inferred_due"], "2026-08-09 06:59:00")
    check("due_is_default set", r1["due_is_default"], 1)
    check("needs_clarification cleared", r1["needs_clarification"], 0)

    print("[migration] provenance + expand/contract")
    check("thought edges written", q("select count(*) n from edges where kind='derives_from' and dst_kind='note'")[0]["n"], 2)
    check("source reminders left intact", q("select count(*) n from reminders")[0]["n"], 3)
    check("source thoughts left intact", q("select count(*) n from thoughts")[0]["n"], 2)
    conn.close()


def test_contract(db_path: str) -> None:
    """`b8f3d1c07a45` drops the four source tables — and can put them back.

    Runs on the DB the expand half just produced, so the round trip is measured
    against rows that actually went through the backfill.
    """
    import sqlite3

    _alembic(db_path, CONTRACT_REVISION)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731
    names = lambda: {  # noqa: E731
        r["name"] for r in q("select name from sqlite_master where type='table'")
    }

    print("\n[contract] the four tables are gone")
    for t in SOURCE_TABLES:
        check(f"{t} dropped", t not in names(), True)
    check("topics survive", "topics" in names(), True)
    check("focus_people survive", "focus_people" in names(), True)

    print("[contract] provenance stamped BEFORE the drop")
    edge_n = lambda k: q(f"select count(*) n from edges where kind='{k}'")[0]["n"]  # noqa: E731
    check("batch provenance edges", edge_n("converged_from_thought_batch"), 2)
    check("thought provenance edges", edge_n("converged_from_thought"), 2)
    # All three reminders — R1 matched through the 2026-08-01 copy's edge, R2 by
    # text, R3 against the promise the expand half inserted.
    check("reminder provenance edges", edge_n("converged_from_reminder"), 3)
    # …and the legacy kind is READ, never written: still just the seeded one.
    check("legacy reminder kind untouched", edge_n("migrated_from_reminder"), 1)
    conn.close()

    # ── the reason this migration is allowed to ship: it reverses ────────────
    _alembic(db_path, EXPAND_REVISION, direction="downgrade")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731

    print("[contract] downgrade rebuilds the rows, original ids intact")
    check("batches back", q("select count(*) n from thought_batches")[0]["n"], 2)
    check("thoughts back", q("select count(*) n from thoughts")[0]["n"], 2)
    check("reminders back", q("select count(*) n from reminders")[0]["n"], 3)
    check("mentions table back (0 rows, as it always was)", q("select count(*) n from mentions")[0]["n"], 0)

    b2 = q("select * from thought_batches where id=2")[0]
    check("batch id preserved", b2["id"], 2)
    check("batch label from the note title", b2["label"], "Gooni pinned the whiteboard.")
    check("image_url rebuilt from the attachment", b2["image_url"], "https://pub-abc.r2.dev/images/2026/08/01/xy.png")

    t1 = q("select * from thoughts where id=1")[0]
    check("thought content", t1["content"], "the store should stay dumb")
    check("thought re-parented to its batch", t1["batch_id"], 1)

    r1 = q("select * from reminders where id=1")[0]
    check("owed_to survives the round trip", r1["owed_to"], 1)
    check("type re-derived from owed_to", r1["type"], "promise")
    check("defaulted due survives", r1["due_at"], "2026-08-09 06:59:00")
    check("due_is_default survives", r1["due_is_default"], 1)
    r3 = q("select * from reminders where id=3")[0]
    check("thought_id restored via the derives_from edge", r3["thought_id"], 2)
    conn.close()

    # Back to head — the adapter half runs against the shipped schema.
    _alembic(db_path, "head")
    conn = sqlite3.connect(db_path)
    gone = {
        r[0] for r in conn.execute("select name from sqlite_master where type='table'")
    }
    check("re-upgrade drops them again", any(t in gone for t in SOURCE_TABLES), False)
    conn.close()


def _seed_through_expand(db_path: str) -> None:
    """PRE → seed the 2026-08-08 prod shape → EXPAND. Source tables still up."""
    import sqlite3

    _alembic(db_path, PRE_REVISION)
    conn = sqlite3.connect(db_path)
    conn.executescript(SEED)
    conn.commit()
    conn.close()
    _alembic(db_path, EXPAND_REVISION)


def test_downgrade_through_prior_copy_spares_adopted(db_path: str) -> None:
    """`d1a4c7f2b8e6.downgrade()` must delete only the promises IT inserted.

    It hard-deletes every promise reachable by `migrated_from_reminder`, on the
    premise that it created them. The contract half therefore stamps its own
    `converged_from_*` kinds: a promise it merely ADOPTED (connector-written,
    text-matched) must survive a rollback past that revision.
    """
    import sqlite3

    _seed_through_expand(db_path)
    _alembic(db_path, CONTRACT_REVISION)
    _alembic(db_path, BELOW_PRE_REVISION, direction="downgrade")

    print("\n[contract] rollback through the 2026-08-01 copy spares adopted promises")
    conn = sqlite3.connect(db_path)
    live = lambda utt: conn.execute(  # noqa: E731
        "select count(*) from promises where utterance=?", (utt,)
    ).fetchone()[0]
    check("promise d1a4c7f2b8e6 created is removed by its own downgrade", live("Get plants for the new place"), 0)
    check("connector-written promise merely adopted survives", live("Write down goals"), 1)
    check("promise the expand half inserted survives", live("Study system design"), 1)
    conn.close()


def test_downgrade_prefers_live_provenance_edge(db_path: str) -> None:
    """A dead provenance stamp must not shadow the live one.

    Operator sequence that produces two edges for one source: roll back through
    `d1a4c7f2b8e6` (it deletes the promises it copied and clears only its OWN
    edge kind, so the `converged_from_reminder` edge is left pointing at a gone
    row), then upgrade back to head — the reminder is re-copied to a NEW promise
    id and stamped again beside the stale edge. The next downgrade has to rebuild
    the reminder from the live stamp instead of giving up on the dead one.
    """
    import sqlite3

    _seed_through_expand(db_path)
    _alembic(db_path, CONTRACT_REVISION)
    _alembic(db_path, BELOW_PRE_REVISION, direction="downgrade")
    _alembic(db_path, "head")

    print("\n[contract] a dead provenance stamp doesn't shadow the live one")
    conn = sqlite3.connect(db_path)
    stamps = [
        r[0]
        for r in conn.execute(
            "select dst_id from edges where kind='converged_from_reminder' "
            "and src_kind='reminder' and src_id=1 order by id"
        )
    ]
    alive = [
        d
        for d in stamps
        if conn.execute("select 1 from promises where id=?", (d,)).fetchone()
    ]
    # Precondition: without both a dead stamp AND a live one, this proves nothing.
    check("reminder 1 carries more than one stamp", len(stamps) > 1, True)
    check("the oldest stamp is dead", stamps[0] not in alive, True)
    check("a later stamp is live", len(alive) > 0, True)
    conn.close()

    _alembic(db_path, EXPAND_REVISION, direction="downgrade")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731
    rebuilt = q("select * from reminders where id=1")
    check("reminder rebuilt from the live stamp, not skipped", len(rebuilt), 1)
    if rebuilt:
        check("rebuilt from the promise the live stamp names", rebuilt[0]["content"], "Get plants for the new place")

    # The same cycle re-stamps batches at a fresh note while the supplanted one
    # survives with a NULL topic_id — existing, but unusable for a NOT NULL
    # column. Every row type has to come back, not just reminders.
    check("batches back", q("select count(*) n from thought_batches")[0]["n"], 2)
    check("thoughts back", q("select count(*) n from thoughts")[0]["n"], 2)
    batch = q("select topic_id from thought_batches where id=1")
    check(
        "batch rebuilt from the usable note, not the topicless one",
        batch[0]["topic_id"] if batch else None,
        1,
    )
    thought = q("select batch_id from thoughts where id=1")
    check(
        "thought re-parented to its batch",
        thought[0]["batch_id"] if thought else None,
        1,
    )
    conn.close()


def test_downgrade_is_partial_not_all_or_nothing(db_path: str) -> None:
    """A stranded source row costs itself, and nothing else.

    Deleting a `thought-batch` note is an ordinary UI action — those notes are not
    hidden from the browser, and `delete_note` does no Edge cleanup — so its
    `converged_from_thought_batch` stamp is left pointing at nothing. Partial
    success is the contract: that batch stays gone, every other row still comes
    back with its original id and fields, and the rollback does NOT abort.
    """
    import sqlite3

    _seed_through_expand(db_path)
    _alembic(db_path, CONTRACT_REVISION)

    conn = sqlite3.connect(db_path)
    stranded = conn.execute(
        "select dst_id from edges where kind='converged_from_thought_batch' "
        "and src_kind='thought_batch' and src_id=2"
    ).fetchone()[0]
    conn.execute("delete from notes where id=?", (stranded,))
    conn.commit()
    # Precondition: the stamp survives the note it names.
    left = conn.execute(
        "select count(*) from edges where kind='converged_from_thought_batch' and src_id=2"
    ).fetchone()[0]
    conn.close()

    print("\n[contract] a stranded stamp costs its own row, not the rollback")
    check("the stamp outlives the deleted note", left, 1)

    _alembic(db_path, EXPAND_REVISION, direction="downgrade")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731
    check("the stranded batch is absent", q("select count(*) n from thought_batches where id=2")[0]["n"], 0)

    b1 = q("select * from thought_batches where id=1")
    check("the other batch is rebuilt", len(b1), 1)
    if b1:
        check("with its original label", b1[0]["label"], "Gooni decided the store stays dumb.")
        check("and its original topic", b1[0]["topic_id"], 1)

    check("both thoughts under the live batch survive", q("select count(*) n from thoughts")[0]["n"], 2)
    t1 = q("select * from thoughts where id=1")
    check("thought content intact", t1[0]["content"] if t1 else None, "the store should stay dumb")
    check("thought still parented to its batch", t1[0]["batch_id"] if t1 else None, 1)

    check("every reminder still rebuilt", q("select count(*) n from reminders")[0]["n"], 3)
    r1 = q("select * from reminders where id=1")
    check("reminder fields intact", r1[0]["content"] if r1 else None, "Get plants for the new place")
    check("owed_to intact", r1[0]["owed_to"] if r1 else None, 1)
    conn.close()


def test_downgrade_skips_a_note_the_old_schema_cant_hold(db_path: str) -> None:
    """A v2 row that drifted out of the old schema's reach costs its own row only.

    `thoughts.content` is NOT NULL, but the note it became is not: `PUT /notes/{id}`
    with `{"content": null, "force": true}` nulls it. Before the fix the rebuild
    walked straight into `NOT NULL constraint failed: thoughts.content`, the
    exception escaped `downgrade()`, and the rollback aborted mid-pass with the
    version stamp unmoved — every row after the bad one lost, not just the bad one.
    """
    import sqlite3

    _seed_through_expand(db_path)
    _alembic(db_path, CONTRACT_REVISION)

    conn = sqlite3.connect(db_path)
    drifted = conn.execute(
        "select dst_id from edges where kind='converged_from_thought' "
        "and src_kind='thought' and src_id=2"
    ).fetchone()[0]
    conn.execute("update notes set content=null where id=?", (drifted,))
    conn.commit()
    # Precondition: the note is still there and still stamped — only its content went.
    left = conn.execute(
        "select count(*) from notes where id=? and content is null", (drifted,)
    ).fetchone()[0]
    conn.close()

    print("\n[contract] a note the old schema can't hold doesn't abort the rollback")
    check("the stamped note survives with NULL content", left, 1)

    _alembic(db_path, EXPAND_REVISION, direction="downgrade")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchall()  # noqa: E731

    check("the unholdable thought is absent", q("select count(*) n from thoughts where id=2")[0]["n"], 0)

    t1 = q("select * from thoughts where id=1")
    check("the other thought is rebuilt", len(t1), 1)
    if t1:
        check("with its original content", t1[0]["content"], "the store should stay dumb")
        check("and its original batch", t1[0]["batch_id"], 1)

    check("both batches still rebuilt", q("select count(*) n from thought_batches")[0]["n"], 2)
    b1 = q("select * from thought_batches where id=1")
    check("batch label intact", b1[0]["label"] if b1 else None, "Gooni decided the store stays dumb.")

    check("every reminder still rebuilt", q("select count(*) n from reminders")[0]["n"], 3)
    r1 = q("select * from reminders where id=1")
    check("reminder content intact", r1[0]["content"] if r1 else None, "Get plants for the new place")
    check("owed_to intact", r1[0]["owed_to"] if r1 else None, 1)
    check("type re-derived", r1[0]["type"] if r1 else None, "promise")
    r3 = q("select * from reminders where id=3")
    # It pointed at thought 2, which couldn't come back — the FK drops rather
    # than dangling, and the reminder itself still does.
    check("the reminder that pointed at it still rebuilds", len(r3), 1)
    check("with a NULL thought_id, not a dangling one", r3[0]["thought_id"] if r3 else "unset", None)
    conn.close()


# Runs the migration IN-PROCESS with a logging.Handler on the root logger, so the
# assertions read real LogRecords rather than migration source. A bare `Config()`
# (no ini path) is what makes that work: `alembic/env.py` only calls `fileConfig`
# when `config_file_name` is set, and `fileConfig` would rip the handler back out.
_CAPTURE_UPGRADE = r"""
import json, logging, os, sys

db_path, rev, repo = sys.argv[1], sys.argv[2], sys.argv[3]
os.environ["DATABASE_URL"] = "sqlite:///" + db_path
sys.path.insert(0, repo)

captured = []


class Capture(logging.Handler):
    def emit(self, record):
        captured.append(
            {"logger": record.name, "level": record.levelname, "message": record.getMessage()}
        )


logging.getLogger().addHandler(Capture())

from alembic import command
from alembic.config import Config

cfg = Config()
cfg.set_main_option("script_location", os.path.join(repo, "alembic"))
command.upgrade(cfg, rev)

sys.stdout.write("@@RECORDS@@" + json.dumps(captured))
"""


def _upgrade_capturing_logs(db_path: str, rev: str) -> list:
    proc = subprocess.run(
        [sys.executable, "-c", _CAPTURE_UPGRADE, db_path, rev, REPO],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or "@@RECORDS@@" not in proc.stdout:
        raise SystemExit(f"capturing upgrade to {rev} failed:\n{proc.stdout}\n{proc.stderr}")
    return json.loads(proc.stdout.split("@@RECORDS@@", 1)[1])


UNRESOLVABLE = """
-- Never backfilled: no `thought` note carries this (timestamp, content).
INSERT INTO thoughts (id,content,timestamp,batch_id)
  VALUES (99,'the expand half never saw this','2026-08-06 09:00:00',1);
-- Empty content: the text matcher has nothing to match on.
INSERT INTO reminders (id,type,content,owed_to,due_at,due_is_default,done,state,
                       resolved_at,thought_id,created_at)
  VALUES (98,'reminder','',NULL,NULL,0,0,'active',NULL,NULL,'2026-08-06 09:00:00'),
-- No promise carries this utterance, and no legacy edge names it.
         (99,'reminder','no promise ever carried this',NULL,NULL,0,0,'active',NULL,NULL,
          '2026-08-06 09:00:00');
"""


def test_upgrade_reports_the_rows_it_destroys(db_path: str) -> None:
    """The drop stays unconditional — but says what it took with it.

    An unresolvable source row is destroyed and unrecoverable (there is no
    provenance edge for `downgrade()` to walk). That is the accepted design;
    `verify_focus_convergence.py` is the sole gate. What was missing was the
    forensic trail for the deploy that skipped it: once the table is gone, this
    log is the only record that the row ever existed.
    """
    import sqlite3

    _seed_through_expand(db_path)
    conn = sqlite3.connect(db_path)
    conn.executescript(UNRESOLVABLE)
    conn.commit()
    conn.close()

    records = _upgrade_capturing_logs(db_path, CONTRACT_REVISION)
    warnings = [r["message"] for r in records if r["level"] == "WARNING"]

    print("\n[contract] upgrade reports every row the drop destroys")
    conn = sqlite3.connect(db_path)
    names = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
    # The destructive behaviour is intentional and must stay: it warned, it did
    # not refuse.
    check("it still dropped the tables", any(t in names for t in SOURCE_TABLES), False)
    check(
        "the unresolvable reminder left no provenance to walk back",
        conn.execute(
            "select count(*) from edges where kind='converged_from_reminder' and src_id=99"
        ).fetchone()[0],
        0,
    )
    check(
        "the resolvable ones were still stamped",
        conn.execute(
            "select count(*) from edges where kind='converged_from_reminder'"
        ).fetchone()[0],
        3,
    )
    conn.close()

    named = lambda needle: any(needle in m for m in warnings)  # noqa: E731
    check("warned about the unbackfilled thought", named("thoughts id 99"), True)
    check("warned about the unmatched reminder", named("reminders id 99"), True)
    check("warned about the empty-content reminder", named("reminders id 98"), True)
    check(
        "said the row is destroyed and unrecoverable",
        any("thoughts id 99" in m and "destroyed" in m and "downgrade" in m for m in warnings),
        True,
    )
    tally = [m for m in warnings if "DESTROYS these source rows" in m]
    check("emitted a closing tally", len(tally), 1)
    if tally:
        check("tally counts the thought", "thoughts: 1 ([99])" in tally[0], True)
        check("tally counts both reminders", "reminders: 2 ([98, 99])" in tally[0], True)
    check(
        "a backfilled row is not reported as lost",
        named("thoughts id 1"),
        False,
    )


# Byte-identical twin, written by the connector after the 2026-08-01 copy — so
# no `migrated_from_reminder` edge names it and the text matcher is the only
# thing that can find it. The É is the whole point: SQLite's `lower()` is
# ASCII-only and Python's is not, so a matcher that folds one side in each
# engine disagrees with the gate on exactly this input.
NON_ASCII_TWIN = "Épargner pour le voyage"
NON_ASCII_SEED = f"""
INSERT INTO reminders (id,type,content,owed_to,due_at,due_is_default,done,state,
                       resolved_at,thought_id,created_at)
  VALUES (97,'reminder','{NON_ASCII_TWIN}',NULL,'2026-08-12 06:59:00',0,0,'active',
          NULL,NULL,'2026-08-06 09:00:00');
INSERT INTO promises (id,cadence,is_important,utterance,summary,inferred_due,state,
                      needs_clarification,slip_count,created_at,updated_at)
  VALUES (97,'once',0,'{NON_ASCII_TWIN}','{NON_ASCII_TWIN}','2026-08-12 06:59:00',
          'active',0,0,'2026-08-06 09:00:00','2026-08-06 09:00:00');
"""


def _run_gate(db_path: str) -> tuple:
    """The real gate, as an operator runs it: exit 0 means every source row is
    accounted for and the contract migration is safe."""
    proc = subprocess.run(
        [sys.executable, "scripts/verify_focus_convergence.py", "--verbose"],
        cwd=REPO,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"},
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_upgrade_stamps_every_twin_the_gate_counted(db_path: str) -> None:
    """The gate and the migration must agree on what "accounted for" means.

    An unconditional drop is only shippable because `verify_focus_convergence.py`
    ran first and said nothing would be lost. If the migration's twin matcher is
    stricter than the gate's on any input, the gate clears a row the migration
    then drops with no provenance edge — permanently, and silently apart from a
    WARNING nobody reads. Pre-folding the parameter in Python (full Unicode) and
    comparing it against SQLite's ASCII-only `lower()` did exactly that.
    """
    import sqlite3

    _seed_through_expand(db_path)
    conn = sqlite3.connect(db_path)
    conn.executescript(NON_ASCII_SEED)
    conn.commit()
    conn.close()

    print("\n[contract] the migration matches every twin the gate counted")
    code, out = _run_gate(db_path)
    # Precondition: if the gate doesn't clear this row, it never reaches the drop
    # and the disagreement this test is about can't happen.
    check("the gate clears the non-ASCII reminder", code, 0)
    check("gate reports no unmatched reminder", "unmatched reminder #97" in out, False)

    _alembic(db_path, CONTRACT_REVISION)

    conn = sqlite3.connect(db_path)
    stamped = conn.execute(
        "select dst_id from edges where kind='converged_from_reminder' "
        "and src_kind='reminder' and src_id=97"
    ).fetchall()
    check("the migration stamped the twin the gate counted", len(stamped), 1)
    if stamped:
        check("stamped at that twin, not another promise", stamped[0][0], 97)
    conn.close()

    _alembic(db_path, EXPAND_REVISION, direction="downgrade")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rebuilt = conn.execute("select * from reminders where id=97").fetchall()
    check("the row survives the round trip", len(rebuilt), 1)
    if rebuilt:
        check("with its content byte-identical", rebuilt[0]["content"], NON_ASCII_TWIN)
        check("and its due intact", rebuilt[0]["due_at"], "2026-08-12 06:59:00")
    check(
        "the rows the gate already covered still come back",
        conn.execute("select count(*) from reminders").fetchone()[0],
        4,
    )
    conn.close()


def test_adapter(db_path: str) -> None:
    """focus_service against the migrated DB — the seam the MCP tools call."""
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
    from app.db.database import SessionLocal
    from app.db.models import Note, Promise
    from app.services import focus_service as fs

    db = SessionLocal()
    try:
        base = datetime(2026, 8, 7, 9, 0, 0)

        print("\n[adapter] log_thought writes Notes")
        first = fs.log_thought(db, content="thinking about the merge", topic_name="Gooni", now=base)
        note = db.query(Note).filter(Note.id == first["thought"]["id"]).first()
        check("thought is a Note", note is not None, True)
        check("tagged thought", '"thought"' in (note.tags or ""), True)
        check("parented to a batch", note.parent_note_id, first["batch"]["id"])
        check("carries topic_id", note.topic_id is not None, True)

        print("[adapter] the 30-minute batch rule")
        same = fs.log_thought(db, content="still on it", topic_name="Gooni", now=base + timedelta(minutes=10))
        check("within window → same batch", same["batch"]["id"], first["batch"]["id"])
        later = fs.log_thought(db, content="new run", topic_name="Gooni", now=base + timedelta(minutes=45))
        check("past window → new batch", later["batch"]["id"] != first["batch"]["id"], True)
        forced = fs.log_thought(db, content="hard turn", topic_name="Gooni", new_batch=True, now=base + timedelta(minutes=46))
        check("new_batch=True forces a batch", forced["batch"]["id"] != later["batch"]["id"], True)

        print("[adapter] `at` backdates (the gap the old tool couldn't close)")
        backdated = fs.log_thought(
            db,
            content="studied dynamo at 1am",
            topic_name="Job search",
            new_batch=True,
            at=datetime(2026, 8, 7, 1, 0, 0),
            now=base + timedelta(hours=3),
        )
        check("timestamp is the backdate, not call time", backdated["thought"]["timestamp"], "2026-08-07T01:00:00+00:00")

        print("[adapter] label refines the running batch card")
        fs.log_thought(db, content="more", topic_name="Gooni", label="Gooni merged the schemas.", now=base + timedelta(minutes=47))
        batch_note = db.query(Note).filter(Note.id == forced["batch"]["id"]).first()
        check("label overwrites batch title", batch_note.title, "Gooni merged the schemas.")

        print("[adapter] query_thoughts reads them back")
        rows = fs.query_thoughts(db, topic="Gooni")
        check("thoughts queryable by topic", len(rows) >= 4, True)
        check("batch label joined", any(r["batch_label"] for r in rows), True)
        hit = fs.query_thoughts(db, text="dynamo")
        check("substring filter works", len(hit), 1)

        print("[adapter] auto_break_overdue honors due_is_default")
        p = Promise(
            utterance="invented deadline", summary="invented deadline", cadence="once",
            state="active", inferred_due=base - timedelta(days=2), due_is_default=True,
            created_at=base - timedelta(days=3), updated_at=base,
        )
        real = Promise(
            utterance="real deadline", summary="real deadline", cadence="once",
            state="active", inferred_due=base - timedelta(days=2), due_is_default=False,
            created_at=base - timedelta(days=3), updated_at=base,
        )
        db.add_all([p, real])
        db.flush()
        fs.auto_break_overdue(db, now=base)
        check("Gooni-invented due never breaks", p.state, "active")
        check("user-chosen due does break", real.state, "broken")

        print("[adapter] dashboard payload keeps every key the FE reads")
        db.commit()
        payload = fs.dashboard(db)
        for key in ("circles", "overflow_topics", "notch", "log", "short_term", "long_term", "rollups", "generated_at"):
            check_true(f"dashboard.{key} present", key in payload)
        for bucket in fs.SHORT_BUCKETS:
            check_true(f"short_term.{bucket} present", bucket in payload["short_term"])
        check_true("notch.reminders present", "reminders" in payload["notch"])
        check_true("notch.promises present", "promises" in payload["notch"])
        check_true("log carries batch labels", all("label" in r for r in payload["log"]))

        print("[adapter] stream still shapes thought cards")
        st = fs.stream(db, days=30, end=datetime(2026, 8, 8).date())
        cards = [i for i in st["items"] if i.get("type") == "thought"]
        check("stream returns thought cards", len(cards) > 0, True)
        check_true("cards carry a sentence", all("sentence" in c for c in cards))
        check_true("cards carry image_url key", all("image_url" in c for c in cards))
    finally:
        db.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "convergence.db")
        test_migration(db_path)
        test_contract(db_path)
        # Need a DB the happy path hasn't already contracted.
        test_downgrade_through_prior_copy_spares_adopted(os.path.join(tmp, "rollback.db"))
        test_downgrade_prefers_live_provenance_edge(os.path.join(tmp, "restamp.db"))
        test_downgrade_is_partial_not_all_or_nothing(os.path.join(tmp, "partial.db"))
        test_downgrade_skips_a_note_the_old_schema_cant_hold(os.path.join(tmp, "drifted.db"))
        test_upgrade_reports_the_rows_it_destroys(os.path.join(tmp, "unstamped.db"))
        test_upgrade_stamps_every_twin_the_gate_counted(os.path.join(tmp, "gate.db"))
        test_adapter(db_path)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}")
        return 1
    print("focus convergence net: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
