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
from app.db.models import Base, Promise  # noqa: E402
from app.services import focus_service as fs  # noqa: E402


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []

    def check(cond: bool, msg: str):
        if not cond:
            fails.append(msg)

    # ── create a self-owed commitment (no due) ───────────────────────────────
    # `is_promise` is INERT. It is passed here on purpose: the old test asserted
    # it drove `type`, and asserting its inertness is what stops that belief
    # coming back. In v2 every row in `promises` IS a promise, so the display
    # `type` is DERIVED from `owed_to` — a commitment owed to another person is
    # the one that reads differently. The MCP surface dropped the parameter
    # entirely in the convergence (see tests/test_mcp_surface.py).
    p = fs.set_reminder(db, content="no smoking until the onsite", is_promise=True)
    pid = p["id"]
    check(p["type"] == "reminder", "is_promise is inert — type derives from owed_to")
    check(p["owed_to"] is None, "self-owed promise has null owner")
    # Every row carries a deadline since 2026-07-29: an omitted due defaults to
    # today's local EOD, flagged so it can never auto-break (breaking a deadline
    # Gooni invented would mark Daniel broken at midnight every night).
    check(p["due_at"] is not None, "omitted due defaults to today EOD, not NULL")
    check(p["due_is_default"] is True, "defaulted due is flagged due_is_default")

    # ── edit content (rename) ────────────────────────────────────────────────
    before_type, before_owner = p["type"], p["owed_to"]
    r = fs.update_reminder(db, pid, content="no smoking, period")
    check(r is not None and r["content"] == "no smoking, period", "content edit persists")
    # Untouched fields survive. The point of this check is INVARIANCE across a
    # rename, not the literal value — so compare against what it was.
    check(r["type"] == before_type and r["owed_to"] == before_owner,
          "rename doesn't demote/reassign")

    # ── set a due via explicit datetime ──────────────────────────────────────
    due = datetime(2026, 8, 1, 23, 0, 0)
    r = fs.update_reminder(db, pid, due_at=due)
    check(r["due_at"] is not None, "due_at set")
    check(r["due_is_default"] is False, "a named deadline clears due_is_default")
    # ── clear the due ────────────────────────────────────────────────────────
    # `clear_due` resets to the today-EOD DEFAULT, not to NULL. A NULL due falls
    # out of both dashboard panels (short-term splits on due distance), so a
    # cleared row would silently vanish from the board.
    r = fs.update_reminder(db, pid, clear_due=True)
    check(r["due_at"] is not None, "clear_due resets to the default due, not NULL")
    check(r["due_is_default"] is True, "cleared due is flagged default again")

    # ── naming an owner promotes + records the person ────────────────────────
    plain = fs.set_reminder(db, content="text yash back")  # plain reminder
    check(plain["type"] == "reminder", "no owner → reminder")
    r = fs.update_reminder(db, plain["id"], owed_to="Yash")
    check(r["type"] == "promise", "naming owner promotes reminder → promise")
    check(r["owed_to"] == "Yash", "owner name resolved back")
    # ── clear the owner ──────────────────────────────────────────────────────
    # This DOES flip the display type back, because `type` is derived from
    # `owed_to` and nothing stores "was promoted once". The pre-convergence
    # test asserted the opposite ("clearing owner leaves it a promise") and
    # `update_reminder`'s docstring still claimed it until this pass. Reported
    # as a finding rather than silently reversed: if "once a promise, always a
    # promise" is still wanted, it needs a stored flag — v2 deliberately has
    # none, and `type` drives no surviving surface.
    r = fs.update_reminder(db, plain["id"], clear_owed=True)
    check(r["owed_to"] is None, "clear_owed nulls owner")
    check(r["type"] == "reminder", "clearing owner re-derives type from owed_to")

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
    # The store is Promise now (the `reminders` table went with the contract
    # half, `b8f3d1c07a45`) — so assert against the row the delete actually hits.
    check(db.query(Promise).filter(Promise.id == pid).first() is None, "row is gone")

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
