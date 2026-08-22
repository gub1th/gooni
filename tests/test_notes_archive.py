"""Regression net for note ARCHIVING — the non-destructive hide.

Deleting was the only way to make a note stop showing up, which is a
destructive answer to a non-destructive question. `is_archived` is the fix, and
its failure mode is SILENT in the worst direction: a listing read somebody
forgot to filter keeps serving the note, and nothing errors — the captain just
keeps seeing the thing he put away, which is precisely the bug the feature
exists to prevent. So the audit of every note-listing read is the test.

Covered here:
  1. the flag round-trips through PATCH /notes/{id}, and `archived_at` is
     stamped on the way IN, not rewritten by a repeat, and cleared on the way
     out
  2. EVERY audited listing read excludes archived notes (the table below is
     the audit, executable)
  3. fetch-by-id still works — archiving hides, it does not lock away
  4. unarchive restores the note whole: content, tags, pins, public flag
  5. no cascade — a child of an archived parent is untouched, and the parent's
     attachments/links survive
  6. the traps: the daily-log upsert must not write into an archived row, the
     empty-note cleanup must not sweep archived notes, and semantic search
     must drop them from RESULTS while KEEPING their embedding
  7. the migration applies to a populated DB and reverses

No LLM calls (the embedder is stubbed), no network. Throwaway file SQLite DB.

Usage:
  source venv/bin/activate
  python tests/test_notes_archive.py
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_ROOT, ".env"))
except Exception:
    pass

os.environ.setdefault("OPENAI_API_KEY", "test-key-not-used")

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Note, Settings  # noqa: E402
from app.routers import notes as notes_router  # noqa: E402
from app.routers import public as public_router  # noqa: E402
from app.services import activity_service, note_service  # noqa: E402
from app.services.note_service import service as note_service_impl  # noqa: E402

Base.metadata.create_all(bind=engine)

# `create_all` doesn't build FTS5 virtual tables (migration c7e3d9b8a1f2 does),
# and without one `_search_fts` fails OPEN — which would leave the FTS half of
# the search filter silently untested. Stand up the same table + triggers here.
with engine.begin() as _c:
    from sqlalchemy import text as _sa_text

    _c.execute(_sa_text(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5("
        "title, content, content='notes', content_rowid='id')"
    ))
    _c.execute(_sa_text(
        "CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN "
        "INSERT INTO notes_fts(rowid, title, content) "
        "VALUES (new.id, new.title, new.content); END"
    ))

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def check_true(label: str, got) -> None:
    check(label, bool(got), True)


def _ids(rows) -> set[int]:
    """Ids out of a serialized list response."""
    return {r["id"] for r in rows}


# ── seed ─────────────────────────────────────────────────────────────────────


def _note(db, **kw) -> Note:
    now = datetime.utcnow()
    n = Note(
        created_at=kw.pop("created_at", now),
        updated_at=kw.pop("updated_at", now),
        **kw,
    )
    db.add(n)
    db.flush()
    return n


def seed(db) -> dict[str, Note]:
    """One live note and one archived note in EVERY shape a listing read
    serves, so each read below is a real two-row comparison rather than an
    assertion that an empty list is empty."""
    db.add(Settings(id=1, nudge_tz="America/Los_Angeles"))

    made: dict[str, Note] = {}
    made["plain"] = _note(db, title="plain live", content="<p>alpha</p>", excerpt="alpha")
    made["plain_arch"] = _note(
        db, title="plain archived", content="<p>alpha archived</p>",
        excerpt="alpha archived", is_archived=True, archived_at=datetime.utcnow(),
    )

    made["pinned"] = _note(db, title="pinned live", is_pinned=True)
    made["pinned_arch"] = _note(db, title="pinned archived", is_pinned=True, is_archived=True)


    made["public"] = _note(db, title="public live", content="<p>p</p>", is_public=True)
    made["public_arch"] = _note(db, title="public archived", content="<p>p</p>", is_public=True, is_archived=True)

    made["sticky"] = _note(db, title="sticky live", home_pos=json.dumps({"x": 0.1, "y": 0.2}), tags=json.dumps(["sticky"]))
    made["sticky_arch"] = _note(db, title="sticky archived", home_pos=json.dumps({"x": 0.3, "y": 0.4}), tags=json.dumps(["sticky"]), is_archived=True)

    today = date.today()
    made["daily"] = _note(db, title=today.isoformat(), content="<p>today log</p>", log_date=today, tags=json.dumps(["daily"]))
    made["daily_arch"] = _note(
        db, title=(today - timedelta(days=1)).isoformat(), content="<p>yesterday log</p>",
        log_date=today - timedelta(days=1), tags=json.dumps(["daily"]), is_archived=True,
    )

    made["tagged"] = _note(db, title="tagged live", tags=json.dumps(["idea"]))
    made["tagged_arch"] = _note(db, title="tagged archived", tags=json.dumps(["idea"]), is_archived=True)

    # A parent with two children, one of which is archived. Also the
    # no-cascade fixture: archiving `parent` must leave both children alone.
    made["parent"] = _note(db, title="parent live", content="<p>parent</p>")
    db.flush()
    made["child"] = _note(db, title="child live", parent_note_id=made["parent"].id)
    made["child_arch"] = _note(db, title="child archived", parent_note_id=made["parent"].id, is_archived=True)

    # Embedded pair for the graph + semantic search reads. Hand-built unit
    # vectors so nothing has to call an embedder.
    made["emb"] = _note(db, title="embedded live", content="<p>vector note</p>", embedding=json.dumps([1.0, 0.0, 0.0]))
    made["emb_arch"] = _note(db, title="embedded archived", content="<p>vector note</p>", embedding=json.dumps([1.0, 0.0, 0.0]), is_archived=True)

    db.commit()
    return made


# ── 1. the flag round-trips ──────────────────────────────────────────────────


def test_patch_round_trip(db, made) -> None:
    print("\n[1] PATCH round-trip")
    n = made["plain"]
    out = notes_router.update_note(n.id, {"is_archived": True}, db=db)
    check("PATCH sets is_archived", out["is_archived"], True)
    check_true("PATCH stamps archived_at", out["archived_at"] is not None)
    first_stamp = out["archived_at"]

    # A repeat archive is an idempotent client retry, NOT a re-archiving —
    # rewriting the date would silently reorder the archive list.
    again = notes_router.update_note(n.id, {"is_archived": True}, db=db)
    check("re-archiving keeps the original archived_at", again["archived_at"], first_stamp)

    back = notes_router.update_note(n.id, {"is_archived": False}, db=db)
    check("unarchive clears the flag", back["is_archived"], False)
    check("unarchive clears archived_at", back["archived_at"], None)

    # Archiving is not an edit: it must not jump the note up every recency list.
    before = db.query(Note).filter(Note.id == made["tagged"].id).first().updated_at
    notes_router.update_note(made["tagged"].id, {"is_archived": True}, db=db)
    after = db.query(Note).filter(Note.id == made["tagged"].id).first().updated_at
    check("archiving does not bump updated_at", after, before)
    notes_router.update_note(made["tagged"].id, {"is_archived": False}, db=db)
    # leave the fixture as seeded
    notes_router.update_note(made["tagged_arch"].id, {"is_archived": True}, db=db)


# ── 2. every listing read excludes archived ──────────────────────────────────


def test_listing_reads(db, made) -> None:
    print("\n[2] listing reads exclude archived")

    got = _ids(notes_router.list_notes(db=db))
    check_true("GET /notes keeps the live note", made["plain"].id in got)
    check("GET /notes drops the archived note", made["plain_arch"].id in got, False)

    # A tag is a NARROWING of what to browse, not a request to see what was
    # put away — so the exclusion has to survive ?tag= too.
    tagged = _ids(notes_router.list_notes(tag="idea", db=db))
    check_true("GET /notes?tag= keeps the live tagged note", made["tagged"].id in tagged)
    check("GET /notes?tag= drops the archived tagged note", made["tagged_arch"].id in tagged, False)

    recent = _ids(notes_router.get_recent_notes(limit=100, db=db))
    check_true("GET /notes/recent keeps live", made["plain"].id in recent)
    check("GET /notes/recent drops archived", made["plain_arch"].id in recent, False)

    pinned = _ids(notes_router.get_pinned_notes(db=db))
    check_true("GET /notes/pinned keeps live", made["pinned"].id in pinned)
    check("GET /notes/pinned drops archived (archive beats pin)", made["pinned_arch"].id in pinned, False)

    sticky = _ids(notes_router.list_sticky_notes(db=db))
    check_true("GET /notes/sticky keeps live", made["sticky"].id in sticky)
    check("GET /notes/sticky drops archived", made["sticky_arch"].id in sticky, False)

    daily = _ids(notes_router.list_daily_notes(days=7, db=db))
    check_true("GET /notes/daily keeps live", made["daily"].id in daily)
    check("GET /notes/daily drops archived", made["daily_arch"].id in daily, False)

    kids = _ids(notes_router.get_note_children(made["parent"].id, db=db))
    check_true("GET /notes/{id}/children keeps the live child", made["child"].id in kids)
    check("GET /notes/{id}/children drops the archived child", made["child_arch"].id in kids, False)

    graph = notes_router.notes_graph(db=db)
    gids = {n["id"] for n in graph["nodes"]}
    check_true("GET /notes/graph keeps the live embedded note", made["emb"].id in gids)
    check("GET /notes/graph drops the archived embedded note", made["emb_arch"].id in gids, False)

    pub = _ids(public_router.get_public_notes(db=db))
    check_true("GET /public/notes keeps live", made["public"].id in pub)
    check("GET /public/notes drops archived", made["public_arch"].id in pub, False)

    # The by-id exemption does NOT extend to a public URL: a stale link must
    # stop serving a post the captain believes is off the site.
    try:
        public_router.get_public_note(made["public_arch"].id, db=db)
        check("GET /public/notes/{id} 404s on an archived note", "served", "404")
    except Exception as e:
        check("GET /public/notes/{id} 404s on an archived note", getattr(e, "status_code", None), 404)

    feed = activity_service.build_activity_feed(db, limit=100)
    feed_ids = {it.get("note_id") for it in feed if it.get("kind") == "note"}
    check_true("activity feed keeps live", made["plain"].id in feed_ids)
    check("activity feed drops archived", made["plain_arch"].id in feed_ids, False)

    # Title search — the @-mention picker.
    titles = {n.id for n in note_service.note_service.search_by_title("archived", 25, db)}
    check("title search drops archived", made["plain_arch"].id in titles, False)
    titles_live = {n.id for n in note_service.note_service.search_by_title("plain live", 25, db)}
    check_true("title search keeps live", made["plain"].id in titles_live)


# ── 3. the archive read + fetch by id ────────────────────────────────────────


def test_archive_read_and_by_id(db, made) -> None:
    print("\n[3] the archive read, and fetch-by-id")

    arch = _ids(notes_router.get_archived_notes(db=db))
    check_true("GET /notes/archived returns the archived note", made["plain_arch"].id in arch)
    check("GET /notes/archived excludes live notes", made["plain"].id in arch, False)

    # Recoverability is the whole point: every archived row must be listed by
    # the one read that can restore it.
    all_archived = {n.id for n in db.query(Note).filter(Note.is_archived == True).all()}  # noqa: E712
    check("every archived row is reachable from /notes/archived", arch, all_archived)

    one = notes_router.get_note(made["plain_arch"].id, db=db)
    check("GET /notes/{id} still serves an archived note", one["id"], made["plain_arch"].id)
    check("…and says so", one["is_archived"], True)
    check_true("…with its body intact", "alpha archived" in (one["content"] or ""))


# ── 4. unarchive restores everything ─────────────────────────────────────────


def test_unarchive_restores(db, made) -> None:
    print("\n[4] unarchive restores the note whole")

    n = _note(
        db, title="restore me", content="<p>body</p>", excerpt="body",
        is_pinned=True, is_public=True,
        tags=json.dumps(["alpha", "beta"]), icon="📦",
        embedding=json.dumps([0.0, 1.0, 0.0]),
    )
    db.commit()
    before = notes_router.get_note(n.id, db=db)

    notes_router.update_note(n.id, {"is_archived": True}, db=db)
    check("archived note is out of /notes", n.id in _ids(notes_router.list_notes(db=db)), False)
    check("archived note is out of /notes/pinned", n.id in _ids(notes_router.get_pinned_notes(db=db)), False)

    notes_router.update_note(n.id, {"is_archived": False}, db=db)
    after = notes_router.get_note(n.id, db=db)

    for field in ("title", "content", "excerpt", "is_pinned", "is_public", "tags", "icon"):
        check(f"unarchive preserves {field}", after[field], before[field])
    check_true("unarchive preserves the embedding", db.query(Note).filter(Note.id == n.id).first().embedding is not None)
    check_true("restored note is back in /notes", n.id in _ids(notes_router.list_notes(db=db)))
    check_true("restored note is back in /notes/pinned", n.id in _ids(notes_router.get_pinned_notes(db=db)))
    check("restored note is out of the archive", n.id in _ids(notes_router.get_archived_notes(db=db)), False)


# ── 5. no cascade ────────────────────────────────────────────────────────────


def test_no_cascade(db, made) -> None:
    print("\n[5] archiving never cascades")

    parent, child = made["parent"], made["child"]
    notes_router.update_note(parent.id, {"is_archived": True}, db=db)
    db.expire_all()

    kid = db.query(Note).filter(Note.id == child.id).first()
    check("archiving a parent leaves its child unarchived", bool(kid.is_archived), False)
    check_true("…and the child stays in /notes", child.id in _ids(notes_router.list_notes(db=db)))
    check_true("…and the child keeps its parent link", kid.parent_note_id == parent.id)

    # Nothing was destroyed either — the parent row and its body are intact.
    p = db.query(Note).filter(Note.id == parent.id).first()
    check_true("the archived parent still exists in the DB", p is not None)
    check_true("…with its content", "parent" in (p.content or ""))

    notes_router.update_note(parent.id, {"is_archived": False}, db=db)


# ── 6. the traps ─────────────────────────────────────────────────────────────


def test_traps(db, made) -> None:
    print("\n[6] the traps")

    # (a) The daily-log cell reads EMPTY for an archived day, so a write into
    # that cell must create a fresh note rather than silently filling the
    # invisible one.
    arch_day = made["daily_arch"]
    day_iso = arch_day.log_date.isoformat()
    out = notes_router.upsert_daily_note(day_iso, {"content": "<p>rewritten</p>"}, db=db)
    check("daily upsert does not adopt the archived row", out["id"] == arch_day.id, False)
    db.expire_all()
    still = db.query(Note).filter(Note.id == arch_day.id).first()
    check_true("…and leaves the archived daily note untouched", "yesterday log" in (still.content or ""))
    check_true("…and it stays archived", bool(still.is_archived))

    # (b) The empty-note sweep must never reach an archived note. Archiving is
    # THE non-destructive action; feeding a delete sweep would make it
    # destructive-with-a-delay.
    empty = _note(db, title="", content="<p></p>", is_archived=True, archived_at=datetime.utcnow())
    db.commit()
    result = notes_router.cleanup_empty_notes(dry_run=True, db=db)
    check("cleanup does not target an archived empty note", empty.id in result["ids"], False)

    # (c) Semantic search: archived notes leave the RESULTS and keep their
    # EMBEDDING, so unarchiving is instant and costs no recompute.
    real_embed = note_service_impl.llm_client.generate_embedding
    note_service_impl.llm_client.generate_embedding = lambda *_a, **_k: ([1.0, 0.0, 0.0], 0)
    try:
        hits = {n.id for n in note_service.note_service.search_by_query("vector note", 10, db)}
    finally:
        note_service_impl.llm_client.generate_embedding = real_embed
    check_true("semantic search keeps the live embedded note", made["emb"].id in hits)
    check("semantic search drops the archived one", made["emb_arch"].id in hits, False)

    # The FTS leg on its own: no embedding, so the ONLY way this note can be
    # found is the keyword pass — which has to drop the archived twin too.
    fts_live = _note(db, title="quokka manifesto", content="<p>quokka</p>")
    fts_arch = _note(db, title="quokka archived manifesto", content="<p>quokka</p>", is_archived=True)
    db.commit()
    note_service_impl.llm_client.generate_embedding = lambda *_a, **_k: ([], 0)
    try:
        fts_hits = {n.id for n in note_service.note_service.search_by_query("quokka", 10, db)}
    finally:
        note_service_impl.llm_client.generate_embedding = real_embed
    check_true("FTS search keeps the live note", fts_live.id in fts_hits)
    check("FTS search drops the archived one", fts_arch.id in fts_hits, False)
    kept = db.query(Note).filter(Note.id == made["emb_arch"].id).first()
    check_true("…but the archived note KEEPS its embedding", kept.embedding is not None)

    # (d) Delete is unchanged — still destroys, and still only what it names.
    doomed = _note(db, title="doomed")
    db.commit()
    doomed_id = doomed.id
    notes_router.delete_note(doomed_id, db=db)
    check("DELETE still removes the row", db.query(Note).filter(Note.id == doomed_id).first(), None)


# ── 7. the migration ─────────────────────────────────────────────────────────


def _alembic(db_path: str, rev: str, direction: str = "upgrade") -> tuple[int, str]:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"}
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", direction, rev],
        cwd=_ROOT, env=env, capture_output=True, text=True,
    )
    return proc.returncode, f"{proc.stdout}\n{proc.stderr}"


def test_migration() -> None:
    print("\n[7] migration applies to a populated DB and reverses")
    import sqlite3

    path = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
    rc, log = _alembic(path, "a7f31c9d5e02")
    if rc != 0:
        check("baseline migration to a7f31c9d5e02", log.strip()[-400:], "ok")
        return

    # Populate BEFORE the archive columns exist — the point of the backfill is
    # rows that predate the feature.
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO notes (id, title, content, created_at, updated_at, "
        # is_draft is still a NOT NULL column at THIS revision — the drop
        # (7f3a1c9e04b2) lands later in the chain. The insert has to satisfy
        # the schema as it existed when the archive migration ran.
        "is_public, is_pinned, is_public_pinned, is_draft) "
        "VALUES (1, 'pre-existing', '<p>x</p>', '2026-01-01 00:00:00', "
        "'2026-01-01 00:00:00', 0, 0, 0, 0)"
    )
    con.commit()
    con.close()

    rc, log = _alembic(path, "b2f7c34ae901")
    check("upgrade applies", rc, 0)
    if rc != 0:
        print(log[-800:])
        return

    con = sqlite3.connect(path)
    row = con.execute("SELECT is_archived, archived_at FROM notes WHERE id = 1").fetchone()
    con.close()
    # NEVER null: every listing read filters on this column, and under SQL
    # three-valued logic a NULL fails `== False` — i.e. it would archive the
    # whole pre-existing corpus by omission.
    check("existing rows backfill to FALSE, not NULL", row, (0, None))

    # Re-running must be a no-op (uvicorn boot runs `alembic upgrade head`).
    rc, _ = _alembic(path, "b2f7c34ae901")
    check("re-running the upgrade is a no-op", rc, 0)

    rc, log = _alembic(path, "a7f31c9d5e02", direction="downgrade")
    check("downgrade applies", rc, 0)
    if rc != 0:
        print(log[-800:])
        return
    con = sqlite3.connect(path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(notes)")}
    survived = con.execute("SELECT title FROM notes WHERE id = 1").fetchone()
    con.close()
    check("downgrade drops is_archived", "is_archived" in cols, False)
    check("downgrade drops archived_at", "archived_at" in cols, False)
    check("downgrade loses no notes", survived, ("pre-existing",))

    rc, log = _alembic(path, "b2f7c34ae901")
    check("upgrade again after downgrade", rc, 0)
    if rc != 0:
        print(log[-800:])
    os.unlink(path)


def main() -> int:
    db = SessionLocal()
    try:
        made = seed(db)
        test_patch_round_trip(db, made)
        test_listing_reads(db, made)
        test_archive_read_and_by_id(db, made)
        test_unarchive_restores(db, made)
        test_no_cascade(db, made)
        test_traps(db, made)
    finally:
        db.close()
    test_migration()

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + ", ".join(FAILURES))
        return 1
    print("all note-archive checks passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        try:
            os.unlink(_tmp.name)
        except OSError:
            pass
