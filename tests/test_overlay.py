"""Deterministic-ranker net for the ambient overlay (Slice 4).

No LLM anywhere in this path by design — the AC is "ranker is
deterministic + explicable per zone", so the test asserts both the
ordering AND the reason strings.

Usage:
  source venv/bin/activate
  python tests/test_overlay.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Note, Promise, Settings  # noqa: E402


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []
    now = datetime.utcnow()

    # ── action horizon: overdue → due_soon → important ──
    db.add_all([
        Promise(utterance="overdue thing", summary="overdue thing",
                state="active", inferred_due=now - timedelta(hours=5)),
        Promise(utterance="due tonight", summary="due tonight",
                state="active", inferred_due=now + timedelta(hours=6)),
        Promise(utterance="important no due", summary="important no due",
                state="active", is_important=True),
        Promise(utterance="far future", summary="far future",
                state="active", inferred_due=now + timedelta(days=30)),
        Promise(utterance="kept already", summary="kept already", state="kept"),
    ])
    db.commit()

    from app.services import overlay_service
    zones = overlay_service.build_overlay(db)
    horizon = zones["action_horizon"]
    got = [(e["summary"], e["reason"]) for e in horizon]
    want = [
        ("overdue thing", "overdue"),
        ("due tonight", "due_soon"),
        ("important no due", "important"),
    ]
    if got != want:
        fails.append(f"horizon cascade wrong: {got}")
    print(f"[horizon] {got}")

    # ── trackables today: met/missed/pending per direction ──
    from app.services import trackable_service, daily_metric_service
    from app.common import local_today
    today = local_today(db)
    cal = trackable_service.create(db, name="calories", kind="numeric",
                                   unit="kcal", agg="sum", target=2100)
    prot = trackable_service.create(db, name="protein", kind="numeric",
                                    unit="g", agg="sum", target=170)
    weight = trackable_service.create(db, name="weight", kind="numeric",
                                      unit="kg", agg="last")
    trackable_service.log_entry(db, cal, day=today, value_numeric=1800)
    trackable_service.log_entry(db, prot, day=today, value_numeric=90)
    trackable_service.log_entry(db, weight, day=today - timedelta(days=2),
                                value_numeric=70.5)
    zones = overlay_service.build_overlay(db)
    by_name = {t["name"]: t for t in zones["trackables_today"]}
    if by_name.get("calories", {}).get("status") != "met":  # 1800 ≤ 2100 limit
        fails.append(f"calories status: {by_name.get('calories')}")
    if by_name.get("protein", {}).get("status") != "logged":  # 90 < 170 floor, day not over
        fails.append(f"protein status: {by_name.get('protein')}")
    if by_name.get("weight", {}).get("status") != "pending":  # nothing today
        fails.append(f"weight status: {by_name.get('weight')}")
    print(f"[trackables] " + ", ".join(
        f"{n}={d['status']}" for n, d in sorted(by_name.items())))

    # calories over the limit flips to missed
    trackable_service.log_entry(db, cal, day=today, value_numeric=500)
    zones = overlay_service.build_overlay(db)
    by_name = {t["name"]: t for t in zones["trackables_today"]}
    if by_name.get("calories", {}).get("status") != "missed":  # 2300 > 2100
        fails.append(f"calories over-limit: {by_name.get('calories')}")
    print(f"[trackables] over-limit calories={by_name['calories']['status']} "
          f"({by_name['calories']['reason']})")

    # ── anchor + whoop select read Settings ──
    note = Note(title="2026 goals", content="<p>north star</p>", excerpt="north star")
    db.add(note)
    db.commit()
    s = Settings(id=1, overlay_anchor_note_id=note.id,
                 overlay_whoop_keys='["weight"]')
    db.add(s)
    db.commit()
    zones = overlay_service.build_overlay(db)
    if not zones["anchor"] or zones["anchor"]["title"] != "2026 goals":
        fails.append(f"anchor: {zones['anchor']}")
    ws = zones["whoop_select"]
    if not ws or ws[0]["name"] != "weight" or ws[0]["value"] is not None:
        fails.append(f"whoop_select: {ws}")
    print(f"[anchor] {zones['anchor']}")
    print(f"[whoop_select] {ws}")

    db.close()
    os.unlink(_tmp.name)
    if fails:
        print("\n--- FAIL ---")
        for f in fails:
            print(f"  ! {f}")
        return 1
    print("\n--- all overlay cases passed ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
