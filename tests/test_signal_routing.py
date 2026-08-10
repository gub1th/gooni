"""Regression net for signal ROUTING (extract → intent_router.dispatch → DB).

Distinct from test_extract_signals.py, which only checks that extraction
*emits* the right signals. This guards the next hop: that dispatch actually
routes each signal type to its handler and a row lands. Born from the bug
where the orchestrator forwarded a hand-picked SUBSET of signals to dispatch
and silently dropped a whole signal type — extraction was fine, routing
wasn't, so nothing wrote. (Trackable logging is no longer a routed signal —
it's the explicit LogTrackableEntryTool; covered at the bottom.)

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
from app.db.models import Base, Promise  # noqa: E402
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
        "reply_intent": "acknowledge",
        "memories": [],
    }


def main() -> int:
    db = SessionLocal()
    fails: list[str] = []

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
    # additive numeric fold — create the calories system trackable first
    # (no fitness router path auto-creates it anymore)
    from app.services import daily_metric_service as _dms
    cals = _dms._trackable(db, "calories")
    _ts2.log_entry(db, cals, day=_date2.today(), value_numeric=300, source="manual")
    _ts2.log_entry(db, cals, day=_date2.today(), value_numeric=200, source="manual")
    piv2 = _ts2.pivot(db, cals, days=1)
    total_today = piv2[0]["value"] if piv2 else None
    if total_today is None or total_today < 500:
        fails.append(f"trackable sum-agg: expected >=500, got {total_today}")
    print(f"[trackable] json_pivot={got} cal_today={total_today}")

    # ── LogTrackableEntryTool: the explicit chat write path that replaced the
    #    fitness auto-writer. Deterministic — no LLM. ──
    from app.tools.trackable_tools import LogTrackableEntryTool
    _tool = LogTrackableEntryTool()
    # WHOLE-BASIS: the tool SETS the day (replace), it does not add. calories
    # already has 500 logged above; logging 400 collapses today to 400.
    res = _tool.execute(db=db, name="calories", value=400)
    after2 = (_ts2.pivot(db, "calories", days=1) or [{}])[0].get("value")
    if "set" not in res.lower() or after2 != 400:
        fails.append(f"log tool whole-basis: expected today=400, got {after2} ({res!r})")
    # boolean SYSTEM trackable auto-creates + logs true (mobile-capture parity)
    exres = _tool.execute(db=db, name="exercise", boolean=True, label="legs")
    expiv = _ts2.pivot(db, "exercise", days=1)
    if "logged" not in exres.lower() or not (expiv and expiv[0]["value"]):
        fails.append(f"log tool boolean: exercise not logged ({exres!r}, {expiv})")
    # unknown NON-system name → honest miss, no crash, no row
    miss = _tool.execute(db=db, name="totally_made_up_xyz", value=1)
    if "no trackable" not in miss.lower():
        fails.append(f"log tool miss: expected 'no trackable', got {miss!r}")
    print(f"[log tool] numeric={res!r} boolean={exres!r} miss_ok={'no trackable' in miss.lower()}")

    # ── feature_requests: the one signal type this net never exercised, which
    #    is how the handler stayed dead. `intent_handlers/features.handle`
    #    imported a name its target module does not export, so it raised
    #    ImportError on EVERY call and `intent_router` caught it into a print.
    #    Every feature request from chat was silently dropped. Assert both
    #    halves: a Note lands, and the router reports a real note id (the id is
    #    what licenses the LLM to confirm the write). ──
    from app.db.models import Note as _Note
    sig = _empty_signals()
    sig["feature_requests"] = [
        {"title": "Outbound time-based reminders", "why": "asked, not built"},
    ]
    routed = intent_router.dispatch(
        {**sig, "memories": []},
        intent_router.RouterContext(db=db),
    )
    if not routed.captured_features:
        fails.append("feature request: routed.captured_features empty — handler dead?")
    else:
        note_id = routed.captured_features[0].get("note_id")
        if not isinstance(note_id, int):
            fails.append(f"feature request: note_id not an int, got {note_id!r}")
        else:
            fr_note = db.query(_Note).filter(_Note.id == note_id).first()
            if fr_note is None:
                fails.append(f"feature request: note_id {note_id} does not exist")
            elif "feature-request" not in (fr_note.tags or ""):
                fails.append(f"feature request: note {note_id} not tagged, tags={fr_note.tags!r}")
    print(f"[feature request] captured={routed.captured_features}")

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
