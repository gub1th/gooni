"""Focus-session distraction alert — one WhatsApp callout per distraction per session.

Two sensors feed it, with deliberately different filters in front of ONE shared
alert path:

  · iOS Shortcuts (`event_service.log_event`) — fires on ANY app-open ping,
    because the Shortcut itself is the distraction list: Daniel only configures
    automations for the apps he wants called out, so a ping arriving IS the
    verdict.
  · Browser intervals (`browser_activity_service.ingest_batch`) — the extension
    reports EVERY host (that is what makes its attention data honest), so a
    verdict has to be applied here: `DISTRACTION_HOSTS` below. Firing on every
    host would alert on the docs site the focus task needs.

The alert core was extracted from `event_service` (PR #494) rather than copied:
two copies of "is a session live, has this subject been called out" is how the
phone and the browser drift into disagreeing — and sharing `_alerted` means
opening Instagram on the PHONE and then in CHROME is one callout, not two,
because both paths key the subject by the same short label ("instagram").

Dedup key = (target_reminder_id, subject) so reopening the same thing doesn't
spam — a new session (new target) is a clean slate. Module-level dict because
there is no session table to hang this on (the session itself is a client
store; `target_reminder_id` + `control_at` on the Settings blob are the only
server-visible trace one exists).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

_alerted: dict[int | None, set[str]] = {}

# Mirrors focus_cam's own run cap (focusTime.ts / focus_attribution.py) — past
# this a `control_at` stamp is stale, not a live session.
MAX_RUN = timedelta(hours=6)

# Browser intervals BUFFER (the extension retains through outages), so an
# interval measured at 14:30 legitimately arrives at 18:00 — and "yo you just
# opened instagram" three hours late is worse than silence. An interval only
# alerts when it ended inside this window. The Shortcuts path passes no
# timestamp: a ping is real-time by construction.
RECENT_WINDOW = timedelta(minutes=10)

# Registrable domains whose browsing during a focus session earns a callout.
# Matched by suffix (`www.instagram.com`, `m.reddit.com` both hit) via
# `is_distraction_host`. A LIST, not a heuristic: the browser sensor reports
# every host, and anything cleverer than membership is a productivity judgement
# the sensor modules all refuse to make. Hand-curated, same pattern as
# `self_hosts.SELF_HOSTS`.
DISTRACTION_HOSTS = frozenset(
    {
        "instagram.com",
        "facebook.com",
        "reddit.com",
        "tiktok.com",
        "twitter.com",
        "x.com",
        "hinge.co",
        "tinder.com",
        "bumble.com",
        "youtube.com",
        "netflix.com",
        "twitch.tv",
        "9gag.com",
        "pinterest.com",
    }
)


def is_distraction_host(host: str | None) -> bool:
    """True when `host` is a distraction domain or a subdomain of one."""
    if not host:
        return False
    h = host.strip().lower().rsplit(":", 1)[0]
    return any(h == d or h.endswith("." + d) for d in DISTRACTION_HOSTS)


def maybe_alert(db: Session, *, subject: str, observed_at: datetime | None = None) -> None:
    """WhatsApp callout when a distraction lands during a LIVE focus session.

    Reads the same `Settings.focus_cam` blob `activity_context.live_focus_session`
    trusts — `control == "running"`, a `target_reminder_id`, and a `control_at`
    stamp inside `MAX_RUN` — so a stale/unstamped blob (an old sidecar, a crashed
    tab) never fires a false alarm.

    `observed_at` (naive UTC) is when the distraction actually happened. When
    given, it must fall inside the running session AND inside `RECENT_WINDOW` —
    a buffered interval flushed hours late must not alert, and one from BEFORE
    the session started was not a distraction from it. Best-effort throughout:
    a failure here must never break the ingest it rides on.
    """
    try:
        from .interval_ingest import parse_dt
        from . import focus_cam_service, promise_service
        from .messaging.whatsapp import whatsapp_channel

        blob = focus_cam_service.get_blob(db)
        if blob.get("control") != "running":
            return
        target_id = blob.get("target_reminder_id")
        if not target_id:
            return
        started = parse_dt(blob.get("control_at"))
        now = datetime.utcnow()
        if started is None or now - started > MAX_RUN or started > now + timedelta(minutes=5):
            return

        if observed_at is not None:
            if observed_at < started or now - observed_at > RECENT_WINDOW:
                return

        sent = _alerted.setdefault(target_id, set())
        if subject in sent:
            return

        promise = promise_service.get(db, target_id)
        task_title = (promise.summary or promise.utterance) if promise else "your focus task"

        target = next(iter(getattr(whatsapp_channel, "_allowed", None) or set()), None)
        if not target:
            return

        text = f"yo you just opened {subject}. you're on \"{task_title}\"."
        delivered = whatsapp_channel.send(target, whatsapp_channel.format_outbound(text))
        if not delivered:
            return
        sent.add(subject)

        from .conversation_service import conversation_service

        conv = conversation_service.find_or_create_session("whatsapp", db)
        conversation_service.add_message(conv.id, "assistant", text, db)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[distraction_alert] alert failed: {e}")
