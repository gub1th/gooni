"""Focus-session distraction alert net — browser + Shortcuts share one path.

No LLM, no HTTP: the WhatsApp channel is stubbed and every send is recorded.
Exercises `distraction_alert` through both of its real callers —
`browser_activity_service.ingest_batch` (host-filtered) and
`event_service.log_event` (unfiltered by design: the Shortcut config IS the
filter) — against a temp SQLite db.

The load-bearing assertions: a buffered browser batch flushed hours late stays
silent (the extension retains through outages, and "you just opened instagram"
three hours later is worse than nothing); a replayed batch can't re-alert; and
the phone and the browser share ONE dedup slot per session, so Instagram on
the phone after Instagram in Chrome is one callout, not two.

Usage:
  source venv/bin/activate
  python tests/test_distraction_alert.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Promise  # noqa: E402
from app.services import (  # noqa: E402
    browser_activity_service as bas,
    distraction_alert,
    event_service,
    focus_cam_service,
)
from app.services.messaging.whatsapp import whatsapp_channel  # noqa: E402

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


SENT: list[str] = []


def _stub_channel():
    whatsapp_channel._allowed = {"15551230000"}
    whatsapp_channel.send = lambda recipient, text: (SENT.append(text), True)[1]
    whatsapp_channel.format_outbound = lambda text: text


_seq = {"n": 0}


def _iv(*, host, start, seconds=120, **extra):
    _seq["n"] += 1
    return {
        "client_id": f"cid-{_seq['n']}",
        "host": host,
        "path": "/",
        "url": f"https://{host}/",
        "title": host,
        "started_at": start.isoformat(),
        "ended_at": (start + timedelta(seconds=seconds)).isoformat(),
        "end_reason": "tab_change",
        **extra,
    }


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    _stub_channel()

    p = Promise(utterance="grind system design", summary="grind system design")
    db.add(p)
    db.commit()
    db.refresh(p)

    now = datetime.utcnow()

    # ── the pure host predicate ──────────────────────────────────────────────
    check(distraction_alert.is_distraction_host("instagram.com"), "bare domain matches")
    check(distraction_alert.is_distraction_host("www.instagram.com"), "www subdomain matches")
    check(distraction_alert.is_distraction_host("m.reddit.com"), "m. subdomain matches")
    check(not distraction_alert.is_distraction_host("github.com"), "work host doesn't match")
    check(
        not distraction_alert.is_distraction_host("notinstagram.com"),
        "suffix match needs a dot boundary",
    )
    check(not distraction_alert.is_distraction_host(None), "None host doesn't match")

    # ── no session → no alert ────────────────────────────────────────────────
    focus_cam_service.set_control(db, "idle")
    bas.ingest_batch(db, [_iv(host="www.instagram.com", start=now - timedelta(minutes=2))])
    check(SENT == [], "no live session → silence")

    # ── live session: distraction host alerts once, with the task title ──────
    focus_cam_service.set_control(db, "running", target_reminder_id=p.id)
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = (now - timedelta(minutes=30)).isoformat()  # session began 30m ago
    focus_cam_service._write_blob(db, blob)
    bas.ingest_batch(db, [_iv(host="www.instagram.com", start=now - timedelta(minutes=2))])
    check(len(SENT) == 1, "distraction during session → one alert")
    check("instagram" in SENT[-1] and "grind system design" in SENT[-1],
          "alert names the short label and the task")

    # ── same host again → dedup ──────────────────────────────────────────────
    bas.ingest_batch(db, [_iv(host="instagram.com", start=now - timedelta(minutes=1))])
    check(len(SENT) == 1, "same subject again → no second alert")

    # ── the PHONE opening the same app shares the dedup slot ─────────────────
    event_service.log_event(db, subject="Instagram", event="open")
    check(len(SENT) == 1, "phone open of an already-alerted subject → silence")

    # ── a NEW subject from the phone still alerts (Shortcuts path intact) ────
    event_service.log_event(db, subject="Hinge", event="open")
    check(len(SENT) == 2 and "hinge" in SENT[-1], "Shortcuts ping still alerts")

    # ── non-distraction browser host → silence ───────────────────────────────
    bas.ingest_batch(db, [_iv(host="github.com", start=now - timedelta(minutes=1))])
    check(len(SENT) == 2, "work host → no alert")

    # ── a replayed batch (all duplicates) can't re-alert ─────────────────────
    distraction_alert._alerted.clear()
    replay = _iv(host="www.reddit.com", start=now - timedelta(minutes=2))
    bas.ingest_batch(db, [replay])
    check(len(SENT) == 3, "fresh distraction host alerts")
    distraction_alert._alerted.clear()  # forget the dedup — only storage should gate
    bas.ingest_batch(db, [replay])
    check(len(SENT) == 3, "replayed duplicate batch → no re-alert even with dedup cleared")

    # ── a buffered interval flushed late stays silent ────────────────────────
    distraction_alert._alerted.clear()
    bas.ingest_batch(db, [_iv(host="www.tiktok.com", start=now - timedelta(hours=3))])
    check(len(SENT) == 3, "interval ended hours ago → no alert")

    # ── an interval from BEFORE the session started stays silent ─────────────
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = (now - timedelta(minutes=5)).isoformat()
    focus_cam_service._write_blob(db, blob)
    bas.ingest_batch(db, [_iv(host="www.twitch.tv", start=now - timedelta(minutes=8), seconds=60)])
    check(len(SENT) == 3, "interval ended before session start → no alert")
    bas.ingest_batch(db, [_iv(host="www.twitch.tv", start=now - timedelta(minutes=3))])
    check(len(SENT) == 4, "interval inside the session window → alerts")

    # ── a stale control_at (crashed tab) never fires ─────────────────────────
    distraction_alert._alerted.clear()
    blob = focus_cam_service.get_blob(db)
    blob["control_at"] = (now - timedelta(hours=7)).isoformat()
    focus_cam_service._write_blob(db, blob)
    bas.ingest_batch(db, [_iv(host="www.netflix.com", start=now - timedelta(minutes=1))])
    check(len(SENT) == 4, "stale control_at → no alert")

    db.close()
    print()
    if _failures:
        print(f"{len(_failures)} FAILURES")
        return 1
    print("all ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
