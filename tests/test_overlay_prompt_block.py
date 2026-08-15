"""Net for the overlay → prompt block wiring (the proactive-context pass).

overlay_service's ranked horizon + today's trackable fold now ride in the
orchestrator's dynamic context on EVERY source. Three things must hold and
none of them need an LLM to check:

  1. The rendered block carries the ranking WITH its reasons, so "what
     should I focus on?" is answerable from context alone.
  2. It carries today's trackable status incl. the numbers, so "how am I
     doing on calories?" is too.
  3. It never silently truncates — a capped list says how much it cut.

Plus the two rules that are easy to regress: a Gooni-invented due date
must not read as a broken deadline, and the block must be bounded.

Usage:
  source venv/bin/activate
  python tests/test_overlay_prompt_block.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

# llm client builds its OpenAI singleton at import; load .env first so the
# test runs outside an activated shell (same pattern as test_overlay).
from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Promise  # noqa: E402


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []
    now = datetime.utcnow()

    from app.services.orchestrator.prompt_blocks import (
        OVERLAY_HORIZON_CAP,
        _build_overlay_block,
    )

    # ── empty state renders nothing (no "0 promises" noise) ──
    if _build_overlay_block(db) != "":
        fails.append("empty DB should render an empty block")

    # ── the ranked horizon, with reasons ──
    db.add_all([
        Promise(utterance="ship the overlay block", summary="ship the overlay block",
                state="active", inferred_due=now - timedelta(days=2)),
        Promise(utterance="call the dentist", summary="call the dentist",
                state="active", inferred_due=now + timedelta(hours=5)),
        Promise(utterance="gym", summary="gym", state="active",
                is_important=True, cadence="n_per_week", cadence_target=4),
        # A due NOBODY chose: overlay_service ranks it overdue, but the
        # block must say so — auto_mark_overdue skips these for the same
        # reason (breaking a deadline Gooni invented marks Daniel broken
        # at midnight on a commitment he never made).
        Promise(utterance="auto-dated thing", summary="auto-dated thing",
                state="active", inferred_due=now - timedelta(hours=3),
                due_is_default=True),
    ])
    db.commit()

    block = _build_overlay_block(db)
    print("─" * 60)
    print(block)
    print("─" * 60)

    for needle, why in [
        ("ship the overlay block", "overdue promise not named"),
        ("overdue by 2d", "overdue distance not rendered"),
        ("call the dentist", "due-soon promise not named"),
        ("due in 5h", "due-soon distance not rendered"),
        ("gym", "important promise not named"),
        ("flagged important", "important reason not rendered"),
        ("[4x/wk]", "cadence tag not rendered"),
        ("auto-set date", "a Gooni-invented due reads as a real deadline"),
    ]:
        if needle not in block:
            fails.append(f"{why} (missing {needle!r})")

    # Ranking order survives rendering: overdue before due_soon before
    # important. (A block that carries the rows but scrambles the order
    # answers "what should I focus on?" wrong.)
    order = [block.find(s) for s in
             ("ship the overlay block", "call the dentist", "gym")]
    if order != sorted(order) or -1 in order:
        fails.append(f"horizon order lost in rendering: {order}")

    # ── the cap is announced, never silent ──
    db.add_all([
        Promise(utterance=f"overflow {i}", summary=f"overflow {i}",
                state="active", inferred_due=now - timedelta(days=3 + i))
        for i in range(4)
    ])
    db.commit()
    block = _build_overlay_block(db)
    if "more in the horizon" not in block:
        fails.append("capped horizon didn't announce the cut")
    named = block.count("  · \"")
    if named > OVERLAY_HORIZON_CAP:
        fails.append(f"horizon cap breached: {named} named rows")
    print(f"[cap] {named} named rows + overflow line")

    # ── trackables: status AND the numbers ──
    from app.common import local_today
    from app.services import trackable_service

    today = local_today(db)
    cal = trackable_service.create(db, name="calories", kind="numeric",
                                   unit="kcal", agg="sum", target=2100)
    prot = trackable_service.create(db, name="protein", kind="numeric",
                                    unit="g", agg="sum", target=170)
    trackable_service.create(db, name="weight", kind="numeric", unit="kg",
                             agg="last", is_important=True)
    trackable_service.log_entry(db, cal, day=today, value_numeric=2400)
    trackable_service.log_entry(db, prot, day=today, value_numeric=90)

    block = _build_overlay_block(db)
    print("─" * 60)
    print(block)
    print("─" * 60)
    for needle, why in [
        ("calories: missed", "over-limit calories not surfaced as missed"),
        ("2400 vs limit 2100", "the calorie numbers aren't in context"),
        ("protein: in progress", "a floor mid-day should read in-progress, not missed"),
        ("90 vs floor 170", "the protein numbers aren't in context"),
        ("nothing logged today: weight", "pending trackable not named"),
    ]:
        if needle not in block:
            fails.append(f"{why} (missing {needle!r})")

    # ── promise integrity rides along once there's a sample ──
    db.add_all([
        Promise(utterance="kept a", summary="kept a", state="kept",
                resolved_at=now - timedelta(days=1)),
        Promise(utterance="kept b", summary="kept b", state="kept",
                resolved_at=now - timedelta(days=2)),
        Promise(utterance="broke c", summary="broke c", state="broken",
                resolved_at=now - timedelta(days=3)),
    ])
    db.commit()
    block = _build_overlay_block(db)
    if "promise integrity:" not in block or "/100" not in block:
        fails.append("integrity score missing once 3 promises are resolved")
    if "2 kept in a row" not in block:
        fails.append("kept streak missing from the integrity line")

    # ── bounded: ~200 tokens is the budget, ~4 chars/token ──
    print(f"[size] {len(block)} chars ≈ {len(block) // 4} tokens")
    if len(block) > 1200:
        fails.append(f"block over budget: {len(block)} chars")

    # ── and it reaches the prompt on BOTH web and bot ──
    import inspect

    from app.services.orchestrator import core as _core

    # NB: `core.Orchestrator` is rebound to the INSTANCE at module bottom.
    src = inspect.getsource(_core.Orchestrator._assemble_context)
    call_lines = [ln for ln in src.splitlines() if "_build_overlay_block(db)" in ln]
    if not call_lines:
        fails.append("overlay block never built in _assemble_context")
    if "overlay_block," not in src:
        fails.append("overlay block never joined into dynamic_context")
    # It must stay at method-body level — anything deeper means it picked
    # up a channel gate like the `if source != "web"` the bot-delivery
    # block still sits behind. Web chat has UI showing these rows, but the
    # MODEL can't see UI. Indentation is the check because calling
    # _assemble_context for real would drag in memory recall (network) for
    # a net that must not need it.
    for ln in call_lines:
        indent = len(ln) - len(ln.lstrip())
        if indent > 12:  # 8 = method body, 12 = inside a `try:` at body level
            fails.append(f"overlay block looks gated (indent {indent}): {ln.strip()}")
    # And the gate must not have grown back around it: `source` may not be
    # tested anywhere between the block's build and its join.
    between = src.split("overlay_block = \"\"")[-1].split("overlay_block,")[0]
    if 'source != "web"' in between or "source ==" in between:
        fails.append("a channel gate appeared around the overlay block")

    db.close()
    os.unlink(_tmp.name)
    if fails:
        print("\n--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("\n--- all overlay-prompt-block cases passed ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
