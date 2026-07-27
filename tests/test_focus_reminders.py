"""Focus reminder/promise CRUD net — the add / edit / delete path behind the
home rail (focus_service.update_reminder + delete_reminder).

No LLM, no HTTP: exercises focus_service against a temp SQLite db (same harness
as test_event). Asserts content/due/owner edits, clear semantics, the
reminder→promise promotion on naming an owner, and hard-delete.

Usage:
  source venv/bin/activate
  python tests/test_focus_reminders.py
"""

import os
import sys
import tempfile
from datetime import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Reminder  # noqa: E402
from app.services import focus_service as fs  # noqa: E402


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []

    def check(cond: bool, msg: str):
        if not cond:
            fails.append(msg)

    # ── create a self-owed promise (no due) ──────────────────────────────────
    p = fs.set_reminder(db, content="no smoking until the onsite", is_promise=True)
    pid = p["id"]
    check(p["type"] == "promise", "is_promise → type promise")
    check(p["owed_to"] is None, "self-owed promise has null owner")
    check(p["due_at"] is None, "no due set")

    # ── edit content (rename) ────────────────────────────────────────────────
    r = fs.update_reminder(db, pid, content="no smoking, period")
    check(r is not None and r["content"] == "no smoking, period", "content edit persists")
    # untouched fields survive
    check(r["type"] == "promise" and r["owed_to"] is None, "rename doesn't demote/reassign")

    # ── set a due via explicit datetime ──────────────────────────────────────
    due = datetime(2026, 8, 1, 23, 0, 0)
    r = fs.update_reminder(db, pid, due_at=due)
    check(r["due_at"] is not None, "due_at set")
    # ── clear the due ────────────────────────────────────────────────────────
    r = fs.update_reminder(db, pid, clear_due=True)
    check(r["due_at"] is None, "clear_due nulls due_at")

    # ── naming an owner promotes + records the person ────────────────────────
    plain = fs.set_reminder(db, content="text yash back")  # plain reminder
    check(plain["type"] == "reminder", "no owner/flag → reminder")
    r = fs.update_reminder(db, plain["id"], owed_to="Yash")
    check(r["type"] == "promise", "naming owner promotes reminder → promise")
    check(r["owed_to"] == "Yash", "owner name resolved back")
    # ── clear the owner (does NOT demote) ────────────────────────────────────
    r = fs.update_reminder(db, plain["id"], clear_owed=True)
    check(r["owed_to"] is None, "clear_owed nulls owner")
    check(r["type"] == "promise", "clearing owner leaves it a promise (self-owed)")

    # ── empty content rejected ───────────────────────────────────────────────
    try:
        fs.update_reminder(db, pid, content="   ")
        check(False, "empty content should raise")
    except ValueError:
        pass

    # ── missing id → None (404 upstream) ─────────────────────────────────────
    check(fs.update_reminder(db, 999_999, content="x") is None, "update missing id → None")
    check(fs.delete_reminder(db, 999_999) is False, "delete missing id → False")

    # ── hard-delete ──────────────────────────────────────────────────────────
    check(fs.delete_reminder(db, pid) is True, "delete existing → True")
    db.flush()
    check(db.query(Reminder).filter(Reminder.id == pid).first() is None, "row is gone")

    db.commit()
    db.close()

    if fails:
        print("FOCUS-REMINDER CRUD FAILURES:")
        for f in fails:
            print(f"  ✗ {f}")
        return 1
    print("all focus-reminder CRUD checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
