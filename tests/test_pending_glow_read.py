"""Regression net for the ambient home's limbo-lane read (GET /messages/glowing).

The lane used to be fed by scraping the newest 40 rows of /messages/log and
filtering them in the browser, so the set of promotable commitments was bounded
by RECENCY OF CHATTER rather than by pendingness: once a pending glow fell past
the tail of a busy day, it vanished from the only surface that could promote or
dismiss it and sat `pending` in the database forever.

That failure mode is SILENT — nothing errors, the lane just quietly shows fewer
cards than there are commitments — which is exactly why it needs a test.

No LLM calls; rows are hand-built. Throwaway in-file SQLite DB.

Usage:
  source venv/bin/activate
  python tests/test_pending_glow_read.py
"""

import json
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

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Conversation, Message  # noqa: E402
from app.routers.conversations import messages_glowing, messages_log  # noqa: E402

Base.metadata.create_all(bind=engine)

LOG_TAIL = 40  # what the old client-side filter could see


def _glow(status: str, summary: str) -> str:
    return json.dumps({
        "signals": [{"utterance": summary, "summary": summary, "cadence": "once"}],
        "status": status,
        "promise_ids": [],
    })


def main() -> int:
    db = SessionLocal()
    fails: list[str] = []

    conv = Conversation(source="web")
    db.add(conv)
    db.commit()

    def _msg(content: str, *, signal: str | None = None) -> Message:
        m = Message(
            conversation_id=conv.id,
            role="user",
            content=content,
            has_actionable_signal=signal is not None,
            signal_preview=_glow(signal, content) if signal else None,
        )
        db.add(m)
        db.commit()
        db.refresh(m)
        return m

    # The buried one: pending, then drowned under a day of ordinary chatter.
    buried = _msg("call mum on sunday", signal="pending")
    already_promoted = _msg("gym 6x a week", signal="promoted")
    already_dismissed = _msg("maybe learn rust", signal="dismissed")
    for i in range(LOG_TAIL + 20):
        _msg(f"chatter {i}")
    recent = _msg("book the dentist", signal="pending")

    # ── the failure this replaces: the log tail can no longer see it ──
    tail_ids = {r["id"] for r in messages_log(limit=LOG_TAIL, db=db)}
    if buried.id in tail_ids:
        fails.append("setup is not adversarial — buried glow still inside the log tail")

    payload = messages_glowing(db=db)
    rows = payload["items"]
    ids = [r["id"] for r in rows]

    if buried.id not in ids:
        fails.append("buried pending glow missing — stranded exactly as before")
    if recent.id not in ids:
        fails.append("recent pending glow missing")
    if already_promoted.id in ids:
        fails.append("promoted glow leaked into the pending read")
    if already_dismissed.id in ids:
        fails.append("dismissed glow leaked into the pending read")
    if any(not r["has_actionable_signal"] for r in rows):
        fails.append("unflagged message leaked into the pending read")
    if len(ids) != 2:
        fails.append(f"expected exactly the 2 pending rows, got {len(ids)}")
    if payload["total"] != 2:
        fails.append(f"total counted the wrong set: {payload['total']} (expected 2)")
    if ids != sorted(ids, reverse=True):
        fails.append(f"not newest-first: {ids}")
    if rows and rows[0].get("source") != "web":
        fails.append("conversation source badge missing from the row")
    print(f"[pending read] ids={ids} (buried={buried.id}, recent={recent.id})")

    # A flagged message with NO preview at all is pending by default — the same
    # rule the FE's isGlowing applies. Dropping it would strand it identically.
    bare = _msg("water the plants")
    bare.has_actionable_signal = True
    db.commit()
    if bare.id not in [r["id"] for r in messages_glowing(db=db)["items"]]:
        fails.append("flagged message with a null preview treated as non-pending")

    # The cap is a display concern, but the read has to be able to serve more
    # than MAX_CARDS so `+N more waiting` can be honest.
    if len(messages_glowing(limit=1, db=db)["items"]) != 1:
        fails.append("limit not honoured")

    # ── the count is over the BACKLOG, not over the page ──────────────────
    # `total` drives the lane's "+N more waiting" line. Bound it by `limit`
    # and a 200-glow backlog reports "+47" — a capped number presented as the
    # whole truth. Build a backlog strictly larger than the requested limit.
    backlog_limit = 5
    backlog = [_msg(f"pending backlog {i}", signal="pending") for i in range(backlog_limit * 3)]
    pending_total = 3 + len(backlog)  # buried + recent + bare, then the backlog

    capped = messages_glowing(limit=backlog_limit, db=db)
    if len(capped["items"]) != backlog_limit:
        fails.append(f"page not filled to the limit: got {len(capped['items'])}")
    if capped["total"] != pending_total:
        fails.append(f"total bounded by the limit: {capped['total']} (expected {pending_total})")
    print(f"[overflow count] page={len(capped['items'])} total={capped['total']}")

    # ...and a glow that gets dismissed leaves BOTH numbers, page and total.
    backlog[-1].signal_preview = _glow("dismissed", backlog[-1].content)
    db.commit()
    after = messages_glowing(limit=backlog_limit, db=db)
    if after["total"] != pending_total - 1:
        fails.append(f"dismissed glow still counted: {after['total']} (expected {pending_total - 1})")
    if backlog[-1].id in [r["id"] for r in after["items"]]:
        fails.append("dismissed glow still served in the page")

    db.close()
    os.unlink(_tmp.name)

    if fails:
        print("\n--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("\n--- pending-glow read: all cases passed ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
