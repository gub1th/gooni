"""Net for note folders — `Topic` wearing a notes-shaped API.

Folders are `Topic` rows (`Note.topic_id` FK = exclusive membership,
`Topic.parent_id` self-FK = nesting). No new table, no migration. What the
tests pin is the set of ways a folder tree loses things:

  * a cycle (drag a folder into its own descendant) orphans the branch from
    the root — it vanishes from the sidebar while still holding notes
  * deleting a folder must NEVER delete notes, and must not recursively
    destroy a subtree from one click
  * counts must match what opening the folder shows (direct-only, and
    archived + `thought` rows excluded from BOTH)
  * a note belongs to exactly one folder, and `unfiled` is a real place

Run: python tests/test_note_folders.py   (no network)
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
os.environ.setdefault("OPENAI_API_KEY", "test-key-never-used")

FAILURES: list[str] = []


def check(label, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def check_true(label, got) -> None:
    check(label, bool(got), True)


def _build_db() -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd); os.unlink(path)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"], cwd=REPO,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{path}"},
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"alembic failed:\n{proc.stdout}\n{proc.stderr}")
    return path


def main() -> None:
    path = _build_db()
    os.environ["DATABASE_URL"] = f"sqlite:///{path}"

    from app.db.database import SessionLocal
    from app.db.models import Note
    from app.routers import notes as R
    from app.services.note_service import folders as F

    db = SessionLocal()

    print("\n-- create + nest --")
    work = R.create_note_folder({"name": "work"}, db=db)
    proj = R.create_note_folder({"name": "project", "parent_id": work["id"]}, db=db)
    check("child parented", proj["parent_id"], work["id"])
    dupe = R.create_note_folder({"name": "work"}, db=db)
    check("create is idempotent on name", dupe["id"], work["id"])

    print("\n-- membership is exclusive, and counts match contents --")
    ids = {}
    for title, topic_id, tags, archived in [
        ("in work",      work["id"], None,                False),
        ("also work",    work["id"], None,                False),
        ("in project",   proj["id"], None,                False),
        ("archived one", work["id"], None,                True),
        ("a thought",    work["id"], json.dumps(["thought"]), False),
        ("unfiled one",  None,       None,                False),
    ]:
        n = Note(title=title, content="<p>x</p>", topic_id=topic_id, tags=tags, is_archived=archived)
        db.add(n); db.flush(); ids[title] = n.id
    db.commit()

    out = R.list_note_folders(db=db)
    by_id = {f["id"]: f for f in out["folders"]}
    check("work counts only live, non-thought notes", by_id[work["id"]]["note_count"], 2)
    check("count is DIRECT, not rolled up through children", by_id[proj["id"]]["note_count"], 1)
    check("unfiled is a real place", out["unfiled_count"], 1)

    listed = {n["id"] for n in R.list_notes(topic_id=work["id"], db=db)}
    check("listing matches the count", len(listed), 2)
    check("archived note not listed", ids["archived one"] in listed, False)
    check("thought not listed", ids["a thought"] in listed, False)

    unf = {n["id"] for n in R.list_notes(unfiled=True, db=db)}
    check("unfiled listing matches its count", len(unf), 1)
    check_true("the unfiled note is the right one", ids["unfiled one"] in unf)

    print("\n-- filing a note --")
    R.update_note(ids["unfiled one"], {"topic_id": proj["id"]}, db=db)
    check("note moved into project", R.get_note(ids["unfiled one"], db=db)["topic_id"], proj["id"])
    R.update_note(ids["unfiled one"], {"topic_id": None}, db=db)
    check("null unfiles it", R.get_note(ids["unfiled one"], db=db)["topic_id"], None)

    print("\n-- a cycle is refused --")
    from fastapi import HTTPException
    for label, fid, parent in [
        ("self-parent refused", work["id"], work["id"]),
        ("descendant-parent refused", work["id"], proj["id"]),
    ]:
        try:
            R.update_note_folder(fid, {"parent_id": parent}, db=db)
            check(label, "accepted", "rejected")
        except HTTPException as e:
            check(label, e.status_code, 400)

    print("\n-- delete unfiles notes, lifts children, destroys nothing --")
    before = db.query(Note).count()
    res = R.delete_note_folder(work["id"], db=db)
    # 4, not 2: the unfile is deliberately NOT filtered by visibility. The
    # archived note and the thought note are IN this folder, and leaving their
    # topic_id pointing at a deleted row would surface the moment one is
    # unarchived. Counts hide them; cleanup must not.
    check("every note unfiled, none deleted", res["notes_unfiled"], 4)
    check("child folder lifted", res["children_lifted"], 1)
    check("NO notes destroyed", db.query(Note).count(), before)
    after = R.list_note_folders(db=db)
    kids = {f["id"]: f for f in after["folders"]}
    check("lifted child is now a root folder", kids[proj["id"]]["parent_id"], None)
    check_true("its notes survived", kids[proj["id"]]["note_count"] >= 1)

    db.close()
    os.unlink(path)
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}"); sys.exit(1)
    print("all note-folder checks passed")


if __name__ == "__main__":
    main()
