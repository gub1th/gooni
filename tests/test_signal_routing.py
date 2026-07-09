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
from app.db.models import Base, Promise, TrackableEntry  # noqa: E402
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
    n_metrics = db.query(TrackableEntry).count()
    if not routed.captured_metrics:
        fails.append("fitness: routed.captured_metrics empty")
    if n_metrics < 3:  # exercise(1) + calories(1) + protein(1)
        fails.append(f"fitness: expected >=3 TrackableEntry rows, got {n_metrics}")
    # Slice 2 AC: the calorie log lands as a TrackableEntry ON the calorie
    # Trackable definition, not a free-floating row.
    from app.services import trackable_service as _ts
    cal_t = _ts.get_by_name(db, "calories")
    cal_entries = (
        db.query(TrackableEntry)
        .filter(TrackableEntry.trackable_id == (cal_t.id if cal_t else -1))
        .count()
    )
    if not cal_t or cal_entries < 1:
        fails.append("fitness: no TrackableEntry on the calories Trackable")
    print(f"[fitness] captured_metrics={len(routed.captured_metrics)} "
          f"TrackableEntry_rows={n_metrics} cal_entries={cal_entries}")

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

    # ── promises: unified emit (slice 1) + glow/promote (slice 3) ──
    # Hand-built signals — no LLM. Embedding calls fail gracefully to None
    # without OPENAI_API_KEY; glow + substring-match paths still work.
    import json as _json
    from datetime import date as _d, timedelta as _t
    from app.db.models import Conversation, Message
    next_friday = _d.today() + _t(days=(4 - _d.today().weekday()) % 7 or 7)

    conv = Conversation(source="web")
    db.add(conv)
    db.commit()

    def _msg(text: str) -> Message:
        m = Message(conversation_id=conv.id, role="user", content=text)
        db.add(m)
        db.commit()
        db.refresh(m)
        return m

    def _create_sig(**kw) -> dict:
        base = {
            "kind": "create", "utterance": None, "summary": None,
            "cadence": "once", "cadence_target": None, "due_date": None,
            "due_hint": None, "is_important": False, "parent_hint": None,
            "match": None,
        }
        base.update(kw)
        return base

    # (a) create signal → GLOW annotation, NOT a Promise row (slice 3)
    m1 = _msg("gym 6x a week")
    sig = _empty_signals()
    sig["promises"] = [
        _create_sig(utterance="gym 6x a week", summary="gym six times a week",
                    cadence="n_per_week", cadence_target=6),
    ]
    routed = intent_router.dispatch(
        {**sig, "memories": []},
        intent_router.RouterContext(db=db, source_message_id=m1.id),
    )
    db.refresh(m1)
    n_promises = db.query(Promise).count()
    if n_promises != 0:
        fails.append(f"glow: create should NOT insert a Promise, got {n_promises} rows")
    if not m1.has_actionable_signal or not m1.signal_preview:
        fails.append("glow: message not annotated")
    if not routed.noticed_promises:
        fails.append("glow: routed.noticed_promises empty")
    preview = _json.loads(m1.signal_preview or "{}")
    if preview.get("status") != "pending":
        fails.append(f"glow: expected pending status, got {preview.get('status')}")
    print(f"[promise a] glow={m1.has_actionable_signal} status={preview.get('status')} rows={n_promises}")

    # (b) promote → Promise row with the parsed cadence; undo → row gone,
    #     glow restored (the full 1-click loop, straight through the routes)
    from app.routers.conversations import promote_message, undo_promote
    out = promote_message(m1.id, db=db)
    gym = db.query(Promise).filter(Promise.utterance == "gym 6x a week").first()
    if gym is None or gym.cadence != "n_per_week" or gym.cadence_target != 6:
        fails.append(f"promote: bad row {gym and (gym.cadence, gym.cadence_target)}")
    if (out["message"]["signal_preview"] or {}).get("status") != "promoted":
        fails.append("promote: preview status not promoted")
    undo_promote(m1.id, db=db)
    db.expire_all()
    if db.query(Promise).count() != 0:
        fails.append("undo: promoted Promise row survived")
    db.refresh(m1)
    if (_json.loads(m1.signal_preview or "{}")).get("status") != "pending":
        fails.append("undo: glow not restored to pending")
    print(f"[promise b] promote_cadence={gym and gym.cadence} undo_rows={db.query(Promise).count()}")

    # (c) once-cadence + absolute due_date + importance survive promote
    m2 = _msg("ship the eval by friday")
    sig = _empty_signals()
    sig["promises"] = [
        _create_sig(utterance="ship the eval by friday", summary="ship the eval",
                    cadence="once", due_date=next_friday.isoformat(),
                    is_important=True),
    ]
    intent_router.dispatch({**sig, "memories": []},
                           intent_router.RouterContext(db=db, source_message_id=m2.id))
    promote_message(m2.id, db=db)
    ship = db.query(Promise).filter(Promise.utterance == "ship the eval by friday").first()
    if ship is None or ship.cadence != "once" or ship.inferred_due is None:
        fails.append(f"promise once+due: bad row {ship and (ship.cadence, ship.inferred_due)}")
    if ship is not None and not ship.is_important:
        fails.append("promise once+due: is_important not persisted")
    print(f"[promise c] due={ship and ship.inferred_due} important={ship and ship.is_important}")

    # (d) no-signal turn → no glow, no rows
    m3 = _msg("saw a cool paper today")
    before = db.query(Promise).count()
    intent_router.dispatch({**_empty_signals(), "memories": []},
                           intent_router.RouterContext(db=db, source_message_id=m3.id))
    db.refresh(m3)
    if m3.has_actionable_signal:
        fails.append("no-signal: message wrongly glowed")
    if db.query(Promise).count() != before:
        fails.append("no-signal: promise count moved")
    print(f"[promise d] no-signal glow={m3.has_actionable_signal}")

    # (e) complete via chat match → state flips to kept (still automatic)
    sig = _empty_signals()
    sig["promises"] = [{"kind": "complete", "match": "ship the eval",
                        "utterance": None, "summary": None, "cadence": "once",
                        "cadence_target": None, "due_date": None, "due_hint": None,
                        "is_important": False, "parent_hint": None}]
    routed = intent_router.dispatch(
        {**sig, "memories": []},
        intent_router.RouterContext(db=db, source_message_id=m3.id),
    )
    db.expire_all()
    ship = db.query(Promise).filter(Promise.utterance == "ship the eval by friday").first()
    if ship is None or ship.state != "kept":
        fails.append(f"promise complete: expected kept, got {ship and ship.state}")
    if not routed.completed_promises:
        fails.append("promise complete: routed.completed_promises empty")
    print(f"[promise e] state={ship and ship.state}")

    # ── trackables: generic primitive (slice 2) ──
    # JSON-payload trackable accepts an arbitrary schema — no migration,
    # no validation gate; pivot folds per the definition's agg rule.
    from datetime import date as _date2
    from app.services import trackable_service as _ts2
    sleep = _ts2.create(
        db, name="sleep quality", kind="json",
        schema_hint={"score": "int 0-100", "strain": "float"}, source="manual",
    )
    _ts2.log_entry(db, sleep, day=_date2.today(),
                   value_json={"score": 87, "strain": 12.1, "extra": ["loose", "ok"]})
    piv = _ts2.pivot(db, "sleep quality", days=3)
    got = piv[0]["value"] if piv else None
    if not (isinstance(got, dict) and got.get("score") == 87):
        fails.append(f"trackable json: pivot value wrong: {got}")
    # additive numeric fold
    cals = _ts2.get_by_name(db, "calories")
    _ts2.log_entry(db, cals, day=_date2.today(), value_numeric=300, source="manual")
    _ts2.log_entry(db, cals, day=_date2.today(), value_numeric=200, source="manual")
    piv2 = _ts2.pivot(db, cals, days=1)
    total_today = piv2[0]["value"] if piv2 else None
    if total_today is None or total_today < 500:
        fails.append(f"trackable sum-agg: expected >=500, got {total_today}")
    print(f"[trackable] json_pivot={got} cal_today={total_today}")

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
