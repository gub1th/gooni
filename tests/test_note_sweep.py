"""Net for the note sweeper — `note_service.sweep_stale_notes`.

Embedding + classification used to run on the WRITE path: the editor POSTed
on blur, on dirty-leave and on submit, so one editing session paid for several
embedding calls and several gpt-5.4-mini extractions over successive
half-finished states of the same note. This moves both behind an idle gate.

What the tests pin, each being a way the query could be wrong in a direction
that costs money or loses data:

  * a note still being edited is NOT due (the whole point)
  * a note that went quiet IS due
  * a note whose embedding is current is NOT due — the re-sweep loop
  * an EDIT after an embed makes it due again — the staleness half
  * archived notes are skipped
  * dry_run and classify=False spend nothing

`llm_client.generate_embedding` is the only stub — it is the actual network
boundary. `classify_note` is stubbed separately because it is a SECOND network
call whose absence must not be mistaken for the sweeper skipping it.

Run: python tests/test_note_sweep.py   (no network)
"""

import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
os.environ.setdefault("OPENAI_API_KEY", "test-key-never-used")

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def _build_db() -> str:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.unlink(db_path)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=REPO,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"},
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"alembic upgrade head failed:\n{proc.stdout}\n{proc.stderr}")
    return db_path


def main() -> None:
    db_path = _build_db()
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"

    from app.db.database import SessionLocal
    from app.db.models import Note
    from app.llm import client as llm_mod
    from app.services import note_service as ns
    from app.services.note_service import sweep as sweep_mod

    classified: list[int] = []
    embedded: list[int] = []

    llm_mod.llm_client.generate_embedding = lambda raw: ([0.1] * 8, None)
    # Patch where it is USED, not where it is defined: `sweep` does
    # `from .classify import classify_note`, so the name is bound at import
    # and rebinding the package attribute would not reach it.
    sweep_mod.classify_note = lambda nid: classified.append(nid)

    now = datetime.utcnow()
    old = now - timedelta(hours=3)
    recent = now - timedelta(minutes=5)

    db = SessionLocal()
    ids = {}
    for key, updated, embedded_at, archived in [
        ("quiet",       old,    None,                 False),
        ("being_typed", recent, None,                 False),
        ("current",     old,    old + timedelta(1),   False),
        ("edited_after",old,    old - timedelta(1),   False),
        ("archived",    old,    None,                 True),
    ]:
        n = Note(title=key, content=f"<p>{key} body text</p>", updated_at=updated,
                 embedded_at=embedded_at, is_archived=archived)
        db.add(n)
        db.flush()
        ids[key] = n.id
    db.commit()
    db.close()

    print("\n-- which notes are DUE --")
    due = ns.sweep_stale_notes(dry_run=True)
    check("dry_run spends nothing", (due["processed"], due["failed"]), (0, 0))
    check("dry_run flagged", due.get("dry_run"), True)
    check("3 notes due (quiet, edited_after, + none else)", due["due"], 2)

    print("\n-- a real pass --")
    res = ns.sweep_stale_notes()
    check("processed both due notes", res["processed"], 2)
    check("no failures", res["failed"], 0)
    check("classified both", sorted(classified), sorted([ids["quiet"], ids["edited_after"]]))

    db = SessionLocal()
    rows = {n.title: n for n in db.query(Note).all()}
    check("quiet note embedded", rows["quiet"].embedding is not None, True)
    check("quiet note stamped", rows["quiet"].embedded_at is not None, True)
    check("being_typed untouched", rows["being_typed"].embedding, None)
    check("archived untouched", rows["archived"].embedding, None)
    check("already-current untouched", rows["current"].embedding, None)
    db.close()

    print("\n-- re-sweep is a no-op --")
    classified.clear()
    again = ns.sweep_stale_notes(dry_run=True)
    check("nothing due after a pass", again["due"], 0)

    print("\n-- an edit makes it due again --")
    # A real edit-after-embed: embedded at T, edited at T+1h, now T+3h. Both
    # halves matter — back-dating `updated_at` ALONE leaves it older than the
    # embed, which is not an edit, it is the state the sweeper just created.
    db = SessionLocal()
    n = db.query(Note).filter(Note.title == "quiet").first()
    n.embedded_at = datetime.utcnow() - timedelta(hours=3)
    n.updated_at = datetime.utcnow() - timedelta(hours=2)
    db.commit()
    db.close()
    check("edited note is due again", ns.sweep_stale_notes(dry_run=True)["due"], 1)

    print("\n-- classify=False is the backfill setting --")
    classified.clear()
    res = ns.sweep_stale_notes(classify=False)
    check("embedded", res["processed"], 1)
    check("but did NOT classify", classified, [])

    os.unlink(db_path)
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}")
        sys.exit(1)
    print("all note-sweep checks passed")


if __name__ == "__main__":
    main()
