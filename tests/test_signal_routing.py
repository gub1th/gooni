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
from app.db.models import Base, DailyMetric, Promise  # noqa: E402
from app.services import intent_router  # noqa: E402

Base.metadata.create_all(bind=engine)


def _empty_signals() -> dict:
    """The full signal envelope the orchestrator forwards (memories blanked,
    like the real call). Every key extract_signals can emit must be present —
    that's the invariant the subset-drop bug violated."""
    return {
        "tone_corrections": [],
        "feature_requests": [],
        "promises": [],
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

    # ── backdating: log_date routes to that day, not today ──
    from datetime import timedelta as _td
    yest = (_date.today() - _td(days=1)).isoformat()
    sig = _empty_signals()
    sig["fitness_logs"] = [
        {"log_type": "weight", "weight": 70.8, "weight_unit": "kg", "log_date": yest},
    ]
    intent_router.dispatch({**sig, "memories": []},
                           intent_router.RouterContext(db=db))
    ct_by_day = {r["date"]: r for r in _dms.cut_table(db, _date.today() - _td(days=2), _date.today())}
    if not (ct_by_day.get(yest) and ct_by_day[yest].get("weight") == 70.8):
        fails.append(f"backdate: expected weight 70.8 on {yest}, got {ct_by_day.get(yest)}")
    if ct_by_day.get(_date.today().isoformat(), {}).get("weight") is not None:
        fails.append("backdate: weight leaked onto today")
    print(f"[backdate] {yest} weight={ct_by_day.get(yest, {}).get('weight')} (today not touched)")

    # ── promises: unified emit (ambient-loop v2 slice 1) ──
    # Hand-built signals — no LLM. Embedding calls fail gracefully to None
    # without OPENAI_API_KEY; create + substring-match paths still work.
    from datetime import date as _d, timedelta as _t
    next_friday = _d.today() + _t(days=(4 - _d.today().weekday()) % 7 or 7)

    def _create_sig(**kw) -> dict:
        base = {
            "kind": "create", "utterance": None, "summary": None,
            "cadence": "once", "cadence_target": None, "due_date": None,
            "due_hint": None, "is_important": False, "parent_hint": None,
            "match": None,
        }
        base.update(kw)
        return base

    # (a) recurring cadence lands on the row
    sig = _empty_signals()
    sig["promises"] = [
        _create_sig(utterance="gym 6x a week", summary="gym six times a week",
                    cadence="n_per_week", cadence_target=6),
    ]
    routed = intent_router.dispatch(
        {**sig, "memories": []},
        intent_router.RouterContext(db=db, source_message_id=1),
    )
    gym = db.query(Promise).filter(Promise.utterance == "gym 6x a week").first()
    if gym is None or gym.cadence != "n_per_week" or gym.cadence_target != 6:
        fails.append(f"promise n_per_week: bad row {gym and (gym.cadence, gym.cadence_target)}")
    if not routed.captured_promises:
        fails.append("promise n_per_week: routed.captured_promises empty")
    print(f"[promise a] cadence={gym and gym.cadence} target={gym and gym.cadence_target}")

    # (b) once-cadence with an absolute due_date → inferred_due set;
    #     is_important flag persists
    sig = _empty_signals()
    sig["promises"] = [
        _create_sig(utterance="ship the eval by friday", summary="ship the eval",
                    cadence="once", due_date=next_friday.isoformat(),
                    is_important=True),
    ]
    intent_router.dispatch({**sig, "memories": []},
                           intent_router.RouterContext(db=db, source_message_id=1))
    ship = db.query(Promise).filter(Promise.utterance == "ship the eval by friday").first()
    if ship is None or ship.cadence != "once" or ship.inferred_due is None:
        fails.append(f"promise once+due: bad row {ship and (ship.cadence, ship.inferred_due)}")
    if ship is not None and not ship.is_important:
        fails.append("promise once+due: is_important not persisted")
    print(f"[promise b] due={ship and ship.inferred_due} important={ship and ship.is_important}")

    # (c) no-signal turn → no new Promise rows
    before = db.query(Promise).count()
    intent_router.dispatch({**_empty_signals(), "memories": []},
                           intent_router.RouterContext(db=db, source_message_id=1))
    after = db.query(Promise).count()
    if after != before:
        fails.append(f"promise no-signal: row count moved {before} -> {after}")
    print(f"[promise c] no-signal rows {before} -> {after}")

    # (d) complete via chat match → state flips to kept
    sig = _empty_signals()
    sig["promises"] = [{"kind": "complete", "match": "gym 6x a week",
                        "utterance": None, "summary": None, "cadence": "once",
                        "cadence_target": None, "due_date": None, "due_hint": None,
                        "is_important": False, "parent_hint": None}]
    routed = intent_router.dispatch(
        {**sig, "memories": []},
        intent_router.RouterContext(db=db, source_message_id=1),
    )
    db.expire_all()
    gym = db.query(Promise).filter(Promise.utterance == "gym 6x a week").first()
    if gym is None or gym.state != "kept":
        fails.append(f"promise complete: expected kept, got {gym and gym.state}")
    if not routed.completed_promises:
        fails.append("promise complete: routed.completed_promises empty")
    print(f"[promise d] state={gym and gym.state}")

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
