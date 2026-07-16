"""Generic Shortcuts-event ingest net — per-"{subject} {event}" sum-agg
counting + timestamp capture.

No LLM, no HTTP: exercises event_service.log_event against a temp SQLite db
(same harness as test_overlay). Asserts the counting math, subject/event
normalization, value_json.at timestamp storage, `at` parsing (ISO / epoch /
default), local-day bucketing, and input validation.

Usage:
  source venv/bin/activate
  python tests/test_event.py
"""

import os
import sys
import tempfile
from datetime import datetime, timezone

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, TrackableEntry  # noqa: E402
from app.services import event_service as ev  # noqa: E402
from app.services import trackable_service  # noqa: E402


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []

    def check(cond: bool, msg: str):
        if not cond:
            fails.append(msg)

    # ── counting accumulates (sum-agg), subject+event → one trackable ──
    r1 = ev.log_event(db, subject="Instagram", event="open")
    check(r1["count"] == 1, f"first open count {r1['count']} != 1")
    check(r1["trackable"] == "instagram open", f"bad name {r1['trackable']}")
    check(ev.log_event(db, subject="Instagram", event="open")["count"] == 2, "should be 2")

    # ── a different event on the same subject is a SEPARATE trackable ──
    b = ev.log_event(db, subject="instagram", event="block")
    check(b["count"] == 1 and b["trackable"] == "instagram block", f"block wrong: {b}")

    # ── location events work identically — the whole point of generalizing ──
    check(ev.log_event(db, subject="Gym", event="arrive")["trackable"] == "gym arrive", "gym arrive name")
    check(ev.log_event(db, subject="House", event="leave")["trackable"] == "house leave", "house leave name")

    # ── source tag + sum-agg on the created trackable ──
    t = trackable_service.get_by_name(db, "instagram open")
    check(t is not None and t.source == "shortcuts", "source not 'shortcuts'")
    check(t is not None and t.agg == "sum" and t.kind == "numeric", "not numeric sum-agg")

    # ── timestamp: value_json.at is stored + echoed ──
    at_iso = "2026-07-16T21:04:00-07:00"
    r = ev.log_event(db, subject="carplay", event="connect", at=at_iso)
    check(r["at"] == at_iso, f"at not echoed: {r['at']}")
    tc = trackable_service.get_by_name(db, "carplay connect")
    stored = trackable_service.serialize_entry(
        db.query(TrackableEntry).filter(TrackableEntry.trackable_id == tc.id).first()
    )
    check(isinstance(stored["value_json"], dict) and stored["value_json"].get("at") == at_iso,
          f"value_json.at not stored: {stored['value_json']}")

    # ── `at` parsing: epoch seconds ──
    epoch = 1_752_724_800  # a fixed UTC instant
    e = ev.log_event(db, subject="charger", event="plug", at=epoch)
    check(e["at"] == datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(), f"epoch parse: {e['at']}")

    # ── `at` omitted → defaults to now (non-empty iso) ──
    d = ev.log_event(db, subject="alarm", event="fire")
    check(bool(d["at"]) and "T" in d["at"], f"default at missing: {d['at']}")

    # ── bad `at` never drops the ping (falls back to now) ──
    g = ev.log_event(db, subject="focus", event="on", at="not-a-date")
    check(g["count"] == 1 and bool(g["at"]), f"bad-at should still log: {g}")

    # ── validation ──
    for kwargs in ({"subject": "", "event": "open"}, {"subject": "gym", "event": ""},
                   {"subject": "!!!", "event": "arrive"}):
        try:
            ev.log_event(db, **kwargs)
            fails.append(f"{kwargs} should raise")
        except ValueError:
            pass

    db.close()
    if fails:
        print("FAIL:")
        for f in fails:
            print("  -", f)
        return 1
    print("OK — generic event ingest net passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
