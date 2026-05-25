"""Regression net for signal ROUTING (extract → intent_router.dispatch → DB).

Distinct from test_extract_signals.py, which only checks that extraction
*emits* the right signals. This guards the next hop: that dispatch actually
routes each signal type to its handler and a row lands. Born from the bug
where the orchestrator forwarded a hand-picked SUBSET of signals to dispatch
and silently dropped `fitness_logs` — extraction was fine, routing wasn't, so
no DailyMetric ever wrote.

No LLM calls: signals are hand-built so the test is fast + deterministic.
Uses a throwaway in-file SQLite DB with the full current schema.

Usage:
  source venv/bin/activate
  python tests/test_signal_routing.py
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

# Throwaway DB BEFORE importing app db modules.
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, DailyMetric, Todo  # noqa: E402
from app.services import intent_router  # noqa: E402

Base.metadata.create_all(bind=engine)


def _empty_signals() -> dict:
    """The full signal envelope the orchestrator forwards (memories blanked,
    like the real call). Every key extract_signals can emit must be present —
    that's the invariant the subset-drop bug violated."""
    return {
        "tone_corrections": [],
        "feature_requests": [],
        "soft_promises": [],
        "todos": [],
        "done_signals": [],
        "fitness_logs": [],
        "reply_intent": "acknowledge",
        "memories": [],
    }


def main() -> int:
    db = SessionLocal()
    fails: list[str] = []

    # ── fitness_logs → DailyMetric rows (the regression that started this) ──
    sig = _empty_signals()
    sig["fitness_logs"] = [
        {"log_type": "exercise", "raw_text": "legs day", "needs_estimation": False,
         "metrics": [], "exercise_label": "gym — legs", "correction": False},
        {"log_type": "macros_explicit", "raw_text": "2100 cal 140g protein",
         "needs_estimation": False, "correction": False,
         "metrics": [{"metric_type": "calories", "value": 2100, "unit": "kcal"},
                     {"metric_type": "protein", "value": 140, "unit": "g"}]},
    ]
    routed = intent_router.dispatch({**sig, "memories": []},
                                    intent_router.RouterContext(db=db))
    n_metrics = db.query(DailyMetric).count()
    if not routed.captured_metrics:
        fails.append("fitness: routed.captured_metrics empty")
    if n_metrics < 3:  # exercise(1) + calories(1) + protein(1)
        fails.append(f"fitness: expected >=3 DailyMetric rows, got {n_metrics}")
    print(f"[fitness] captured_metrics={len(routed.captured_metrics)} "
          f"DailyMetric_rows={n_metrics}")

    # ── substance log → boolean cut-table cell (DailyMetric, no Habit) ──
    sig = _empty_signals()
    sig["fitness_logs"] = [
        {"log_type": "substance", "substance": "weed", "raw_text": "smoked a bit"},
    ]
    routed = intent_router.dispatch({**sig, "memories": []},
                                    intent_router.RouterContext(db=db))
    from datetime import date as _date
    from app.services import daily_metric_service as _dms
    ct = _dms.cut_table(db, _date.today(), _date.today())
    if not any(m.get("log_type") == "substance" for m in routed.captured_metrics):
        fails.append("substance: routed.captured_metrics missing substance")
    if not (ct and ct[0].get("weed") == 1.0):
        fails.append(f"substance: expected weed=1.0 in cut table, got {ct}")
    # No Habit row should have been created for the substance.
    from app.db.models import Habit as _Habit
    if db.query(_Habit).filter(_Habit.name == "weed").count() != 0:
        fails.append("substance: a Habit row was created (should be DailyMetric-only)")
    print(f"[substance] weed_cell={ct[0].get('weed') if ct else None} "
          f"habit_rows={db.query(_Habit).filter(_Habit.name == 'weed').count()}")

    # ── todos → Todo row (a second type, proves it's not fitness-specific) ──
    # Needs OPENAI_API_KEY — the todo handler embeds for cosine-dedup.
    if os.getenv("OPENAI_API_KEY"):
        sig = _empty_signals()
        sig["todos"] = [{"kind": "create", "text": "call the dentist", "due_hint": None}]
        intent_router.dispatch({**sig, "memories": []},
                               intent_router.RouterContext(db=db))
        n_todos = db.query(Todo).count()
        if n_todos < 1:
            fails.append(f"todos: expected >=1 Todo row, got {n_todos}")
        print(f"[todos] Todo_rows={n_todos}")
    else:
        print("[todos] SKIP — no OPENAI_API_KEY (embedding-dependent)")

    db.close()
    os.unlink(_tmp.name)

    if fails:
        print("\n--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("\n--- all routing cases passed ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
