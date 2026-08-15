"""Regression net for the verify rail's turn-scoped write ledger.

THE BUG. The orchestrator has two writers that cannot see each other:
`intent_router` fires promise / feature / tone hooks UPSTREAM of the chat
model, and the chat tool loop writes from inside it. The verify step was
handed only the `ToolCall` audit — which structurally can never contain a
router write — plus a prompt rule that resolved the resulting blind spot by
whitelisting it:

    - ROUTER-LAYER CLAIMS ok=true: ... If the draft says "captured" /
      "logged as a feature request" / "added that promise" without an
      explicit chat-side tool call, it's still ACCURATE — the router did
      it. ok=true.

The clause keys on the reply's VOCABULARY, not on whether anything was
written, so the one turn the rail exists to catch — the model narrating a
capture nobody performed — was whitelisted by name. Worse, it named
"added that promise" specifically, which chat-side routing has not done
since Slice 3 made promise creates a GLOW awaiting promotion.

WHAT IS PINNED HERE. `write_ledger` joins both writers into one list that
both rails read, so the LLM verifier can now confirm or deny a router claim
instead of trusting it. These cases are the ones the shape makes easy to get
wrong again:

  * a landed router write still backs a tool-less claim (the happy path the
    whitelist existed to protect — it must survive its removal)
  * a glow is rendered as NOT WRITTEN, not omitted and not counted
  * an off-thread tone preference is queued, not confirmed
  * read-only tool calls back nothing, write tools do
  * an unreadable audit fails OPEN
  * the prompt no longer carries a blanket router whitelist

No LLM calls, no network: the LLM verifier's own judgement is not testable
here, so this pins the EVIDENCE it is given plus the deterministic rail.
Throwaway in-file SQLite DB.

Usage:
  source venv/bin/activate
  python tests/test_verify_ledger.py
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
from app.db.models import Base, ToolCall  # noqa: E402
from app.services.intent_router import RouterResult  # noqa: E402
from app.services.orchestrator import steps  # noqa: E402
from app.services.orchestrator.write_ledger import (  # noqa: E402
    DONE,
    NOTICED,
    QUEUED,
    READ,
    build_ledger,
)

Base.metadata.create_all(bind=engine)

CLAIM = "tracked that for you, sir."


def check(fails: list[str], cond: bool, msg: str) -> None:
    if not cond:
        fails.append(msg)


def _tool(db, name: str, status: str = "done", args: dict | None = None) -> int:
    row = ToolCall(
        tool_name=name,
        status=status,
        args_json=json.dumps(args) if args else None,
    )
    db.add(row)
    db.commit()
    return row.id


class _BrokenDB:
    """A session whose audit read raises — the fail-open case."""

    def query(self, *a, **k):
        raise RuntimeError("audit unavailable")


def main() -> int:  # noqa: C901 — a flat list of cases reads better than helpers
    db = SessionLocal()
    fails: list[str] = []

    # ── 1. The happy path the whitelist protected must survive its removal.
    # A router feature capture with ZERO tool calls still backs the claim,
    # and the ledger says so in a line the verifier can actually read.
    routed = RouterResult(captured_features=[{"title": "dark mode", "note_id": 12}])
    ledger = build_ledger(routed=routed, tool_call_ids=[], db=db)
    check(fails, len(ledger.backing_writes()) == 1,
          f"router feature capture not a backing write: {ledger.records}")
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is None,
          "det rail flagged a claim backed by a router feature capture")
    rendered = ledger.render()
    check(fails, "[router]" in rendered and "Note #12" in rendered and "dark mode" in rendered,
          f"router write not legible to the verifier: {rendered!r}")

    # ── 2. A GLOW is not a write. Chat-side promise creates annotate the
    # message and insert nothing; "added that promise" off one is the exact
    # phrase the old whitelist blessed.
    routed = RouterResult(noticed_promises=[{"summary": "call mom sunday"}])
    ledger = build_ledger(routed=routed, tool_call_ids=[], db=db)
    check(fails, [r.status for r in ledger.records] == [NOTICED],
          f"glow recorded as something other than NOTICED: {ledger.records}")
    check(fails, not ledger.backing_writes(), "a glow counted as a backing write")
    det = steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger)
    check(fails, det is not None, "det rail passed a 'tracked' claim backed only by a glow")
    # ...and it is still SHOWN, loudly. Silence would leave the verifier
    # reasoning from an empty ledger about a turn that did notice something.
    check(fails, "NOT WRITTEN" in ledger.render(),
          f"glow omitted or unmarked in the ledger: {ledger.render()!r}")

    # ── 3. Off-thread tone preference: dispatched, never confirmed.
    routed = RouterResult(tone_rules=["less hedging"])
    ledger = build_ledger(routed=routed, tool_call_ids=[], db=db)
    check(fails, [r.status for r in ledger.records] == [QUEUED],
          f"tone rule not queued: {ledger.records}")
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is not None,
          "det rail treated an unconfirmed off-thread write as backing")

    # ── 4. Read-only tools back nothing; write tools do.
    read_id = _tool(db, "search_notes", args={"query": "protein"})
    ledger = build_ledger(routed=RouterResult(), tool_call_ids=[read_id], db=db)
    check(fails, [r.status for r in ledger.records] == [READ],
          f"read-only tool not marked read: {ledger.records}")
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is not None,
          "det rail let a read-only tool call back a 'tracked' claim")

    write_id = _tool(db, "log_trackable_entry", args={"name": "protein", "value": 40})
    ledger = build_ledger(routed=RouterResult(), tool_call_ids=[write_id], db=db)
    check(fails, [r.status for r in ledger.records] == [DONE],
          f"write tool not marked done: {ledger.records}")
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is None,
          "det rail flagged a claim backed by a real write tool")

    # A failed write tool is in the ledger but backs nothing.
    failed_id = _tool(db, "add_note", status="failed", args={"title": "x"})
    ledger = build_ledger(routed=RouterResult(), tool_call_ids=[failed_id], db=db)
    check(fails, not ledger.backing_writes(), "a failed tool call counted as a write")
    check(fails, "FAILED" in ledger.render(), "failed tool call not marked in the ledger")

    # ── 5. THE HEADLINE CASE: a glow AND an unrelated write tool in one turn.
    # The det rail is object-blind, so the landed add_note suppresses it and
    # the LLM verifier gets the call — which is precisely where the whitelist
    # used to hand it the wrong answer ("added that promise" → ok=true by
    # vocabulary). It can only decide correctly if the ledger both shows the
    # glow as NOT WRITTEN and names the object each line touched.
    note_id = _tool(db, "add_note", args={"title": "protein research"})
    routed = RouterResult(noticed_promises=[{"summary": "call mom sunday"}])
    ledger = build_ledger(routed=routed, tool_call_ids=[note_id], db=db)
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is None,
          "det rail should defer to the verifier when SOME write landed")
    rendered = ledger.render()
    check(fails, "NOT WRITTEN" in rendered and "call mom sunday" in rendered,
          f"glow not denied in a turn that also wrote: {rendered!r}")
    check(fails, "protein research" in rendered,
          f"the landed write's object is missing, so no claim can be matched to it: {rendered!r}")

    # Both writers in one ledger, router first (it ran first).
    routed = RouterResult(
        captured_features=[{"title": "dark mode", "note_id": 12}],
        noticed_promises=[{"summary": "call mom sunday"}],
    )
    ledger = build_ledger(routed=routed, tool_call_ids=[read_id, write_id], db=db)
    layers = [r.layer for r in ledger.records]
    check(fails, layers == ["router", "router", "tool", "tool"],
          f"ledger ordering/coverage wrong: {layers}")

    # ── 6. An unreadable audit fails OPEN — it is not evidence of a lie.
    ledger = build_ledger(routed=RouterResult(), tool_call_ids=[write_id], db=_BrokenDB())
    check(fails, ledger.audit_readable is False, "unreadable audit not flagged")
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is None,
          "det rail flagged a draft on the strength of an unreadable audit")

    # ── 7. Empty turn: a claim with nothing behind it is still caught, and
    # a draft with no claim at all is still clean.
    ledger = build_ledger(routed=RouterResult(), tool_call_ids=[], db=db)
    check(fails, steps._deterministic_unbacked_check(draft=CLAIM, ledger=ledger) is not None,
          "det rail passed a claim on an empty turn")
    check(fails, steps._deterministic_unbacked_check(
              draft="the answer is 42, sir.", ledger=ledger) is None,
          "det rail flagged a draft that claims nothing")
    check(fails, "nothing was written" in ledger.render(),
          f"empty ledger renders misleadingly: {ledger.render()!r}")

    # ── 8. The prompt itself: the blanket whitelist must stay gone, and the
    # verifier must still be told the router writes without a tool call (the
    # legitimate fact the whitelist was a wrong answer to).
    prompt = steps._VERIFY_PROMPT
    check(fails, "ROUTER-LAYER CLAIMS ok=true" not in prompt,
          "the blanket router whitelist is back in _VERIFY_PROMPT")
    check(fails, "the router did it" not in prompt,
          "_VERIFY_PROMPT still tells the verifier to assume the router did it")
    check(fails, "{audit}" in prompt and "LEDGER" in prompt,
          "_VERIFY_PROMPT no longer shows the verifier a ledger")
    check(fails, "upstream" in prompt.lower(),
          "_VERIFY_PROMPT dropped the fact that the router writes upstream")

    db.close()
    os.unlink(_tmp.name)

    if fails:
        print("\n--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("\n--- verify write-ledger: all cases passed ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
