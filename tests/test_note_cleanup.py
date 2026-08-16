"""Regression net for POST /notes/cleanup.

The cleanup route used to require >= 6 chars of plaintext to count a note as
"real content", so short-but-real notes ("gym", "no", "decided to skip") were
swept — it deleted 89 notes including real thoughts. Length is no longer a
criterion: ANY non-whitespace plaintext, any embedded media, or a real title
keeps a note; only truly empty untitled drafts are deleted.

No LLM calls; rows are hand-built. Throwaway in-file SQLite DB.

Usage:
  source venv/bin/activate
  python tests/test_note_cleanup.py
"""

import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_ROOT, ".env"))
except Exception:
    pass

os.environ.setdefault("OPENAI_API_KEY", "test-key-unused")  # module import only; nothing here calls the LLM

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Note  # noqa: E402
from app.routers.notes import cleanup_empty_notes  # noqa: E402

Base.metadata.create_all(bind=engine)


def _note(db, title="", content="", is_pinned=False, is_draft=True):
    n = Note(title=title, content=content, is_pinned=is_pinned, is_draft=is_draft)
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


def main():
    db = SessionLocal()
    try:
        kept = [
            _note(db, content="<p>gym</p>"),                       # 3 chars, real
            _note(db, content="<p>no</p>"),                        # 2 chars, real
            _note(db, content="<p>decided to skip</p>"),           # short phrase
            _note(db, content="<p>decided to skip gym today</p>"),
            _note(db, content='<img src="x.png">'),                # media only
            _note(db, title="basketball thoughts", content=""),    # title only
            _note(db, title="Untitled", content="<p>a</p>"),       # 1 char body
        ]
        pinned_empty = _note(db, content="", is_pinned=True)       # preserved
        deleted = [
            _note(db, content=""),                                 # empty
            _note(db, content=None),                               # null
            _note(db, content="<p>   </p>"),                       # whitespace only
            _note(db, title="   ", content="<p></p>"),             # blank title + empty
            _note(db, title="Untitled", content=""),               # untitled + empty
        ]

        # Dry run reports, deletes nothing.
        dry = cleanup_empty_notes(dry_run=True, db=db)
        assert sorted(dry["ids"]) == sorted(n.id for n in deleted), dry
        assert db.query(Note).count() == len(kept) + 1 + len(deleted)

        res = cleanup_empty_notes(dry_run=False, db=db)
        assert sorted(res["ids"]) == sorted(n.id for n in deleted), res
        assert res["deleted"] == len(deleted)
        assert res["preserved_pinned_empty"] == 1

        survivors = {n.id for n in db.query(Note).all()}
        assert survivors == {n.id for n in kept} | {pinned_empty.id}
        print("OK — cleanup deletes only truly empty notes; short real content survives")
    finally:
        db.close()
        os.unlink(_tmp.name)


if __name__ == "__main__":
    main()
