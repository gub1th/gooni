"""Proactive Gooni — phase 0.

Two deterministic nudges:
  * `maybe_fire_whoop_nudge(row, db)` — call after every
    `whoop.upsert_today_snapshot`. Fires one Alfred-voice ping via
    WhatsApp when the snapshot's source_updated_at is fresh relative
    to the last ping. Pure rules; no LLM judgment.
  * `maybe_fire_sleep_nudge(db)` — call from the lifespan scheduler
    every ~5 min. Fires once per local night if Daniel is active past
    his sleep cutoff hour (default 1am).

Channel is hardcoded to WhatsApp. Daniel doesn't use Telegram and we
don't want web-overlay pings. Idempotency lives on `Settings` so
restarts and horizontal scale-outs can't double-fire.

Designed to be deeply boring: regex-free, branch-light, fail-open.
Every "fire" path is wrapped in try/except so a misfire never crashes
the caller (whoop ingest, scheduler tick).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ..db.models import (
    ClaudeUsageTurn,
    Message,
    Note,
    Settings as SettingsModel,
    WhoopSnapshot,
)
from .messaging.whatsapp import whatsapp_channel


# ── Helpers ──────────────────────────────────────────────────────────


def _settings(db: Session) -> SettingsModel | None:
    return db.query(SettingsModel).filter(SettingsModel.id == 1).first()


def _wa_recipient() -> str | None:
    """First handle from the WHATSAPP_ALLOWED_HANDLES env list. Matches
    the fly_revive pattern. Returns None if env wasn't configured."""
    allowed = getattr(whatsapp_channel, "_allowed", None) or set()
    if not allowed:
        return None
    return next(iter(allowed))


def _send_wa(text: str) -> bool:
    """Format + send via WhatsApp. Returns True on success."""
    recipient = _wa_recipient()
    if not recipient:
        print("[proactive_nudge] no WhatsApp recipient configured — skipped")
        return False
    try:
        formatted = whatsapp_channel.format_outbound(text)
        whatsapp_channel.send(recipient, formatted)
        return True
    except Exception as e:
        print(f"[proactive_nudge] WhatsApp send failed: {e}")
        return False


def _active_signal_within(db: Session, minutes: int) -> bool:
    """True if Daniel has done anything Gooni can observe in the last
    `minutes` minutes. Combines: chat message, claude code turn,
    note write. Each check is independent so one broken table can't
    silence the whole signal."""
    cutoff = datetime.utcnow() - timedelta(minutes=minutes)
    try:
        msg = (
            db.query(Message.id)
            .filter(Message.created_at >= cutoff)
            .filter(Message.role == "user")
            .first()
        )
        if msg:
            return True
    except Exception as e:
        print(f"[proactive_nudge] msg signal check failed: {e}")
    try:
        turn = (
            db.query(ClaudeUsageTurn.id)
            .filter(ClaudeUsageTurn.ts >= cutoff)
            .first()
        )
        if turn:
            return True
    except Exception as e:
        print(f"[proactive_nudge] claude turn signal check failed: {e}")
    try:
        note = (
            db.query(Note.id)
            .filter(Note.updated_at >= cutoff)
            .first()
        )
        if note:
            return True
    except Exception as e:
        print(f"[proactive_nudge] note signal check failed: {e}")
    return False


# ── Whoop nudge ─────────────────────────────────────────────────────


def _compose_whoop_message(row: WhoopSnapshot) -> str:
    """Alfred-voice ping summarizing today's whoop snapshot. Tone tilts
    sharper when stats are bad. Always lowercase, terse."""
    sleep_h = (row.sleep_minutes / 60.0) if row.sleep_minutes else None
    recovery = row.recovery_score
    strain = row.strain

    bits: list[str] = []
    if sleep_h is not None:
        bits.append(f"slept {sleep_h:.1f}h")
    if recovery is not None:
        bits.append(f"recovery {recovery:.0f}%")
    if strain is not None:
        bits.append(f"strain {strain:.1f}")

    if not bits:
        return "whoop synced, sir. no usable numbers in the payload."

    summary = " · ".join(bits)

    # Verdict — deterministic thresholds. Multiple bad signals = harsher
    # opener.
    bad_signals = 0
    if sleep_h is not None and sleep_h < 6.0:
        bad_signals += 1
    if recovery is not None and recovery < 50:
        bad_signals += 1
    if strain is not None and recovery is not None and strain > 18 and recovery < 60:
        bad_signals += 1

    if bad_signals >= 2:
        opener = "whoop just synced, sir. you're cooking yourself."
    elif bad_signals == 1:
        opener = "whoop in, sir. body's not loving today's setup."
    elif recovery is not None and recovery >= 75:
        opener = "whoop in — body's primed today, sir."
    else:
        opener = "whoop synced, sir."

    return f"{opener} {summary}."


def maybe_fire_whoop_nudge(row: WhoopSnapshot, db: Session) -> bool:
    """Fire a whoop-stats ping if this snapshot's source_updated_at is
    fresh relative to the last ping. Returns True if a ping was sent.

    Fail-open: catches every error path so whoop ingest never breaks
    on a nudge bug. Idempotency lives on Settings.last_whoop_nudge_source_ts.
    """
    if row is None:
        return False
    try:
        s = _settings(db)
        if s is None:
            return False
        src_ts = row.source_updated_at
        # No source timestamp from Whoop — fall back to row.updated_at so
        # we still ping when the row is genuinely new today.
        compare_ts = src_ts or row.updated_at
        if compare_ts is None:
            return False
        if s.last_whoop_nudge_source_ts is not None and compare_ts <= s.last_whoop_nudge_source_ts:
            # Same (or older) snapshot — already pinged.
            return False
        message = _compose_whoop_message(row)
        if not _send_wa(message):
            return False
        s.last_whoop_nudge_source_ts = compare_ts
        db.commit()
        return True
    except Exception as e:
        print(f"[proactive_nudge] whoop nudge errored (ignored): {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return False


# ── Sleep nudge ─────────────────────────────────────────────────────


_DEFAULT_SLEEP_CUTOFF_HOUR = 1


def _local_now(s: SettingsModel | None) -> datetime:
    tz_name = (s.nudge_tz if s else None) or "America/Los_Angeles"
    return datetime.now(ZoneInfo(tz_name))


def _compose_sleep_message(now: datetime) -> str:
    """Alfred-voice ping for late-night activity. Deliberately concrete —
    references the actual hour so the ping reads grounded, not robotic."""
    hh = now.strftime("%I:%M %p").lstrip("0").lower()
    return (
        f"{hh}, sir. you're still up. fix the sleep sched or own the choice — "
        "but don't pretend tomorrow won't pay for it."
    )


def maybe_fire_sleep_nudge(db: Session) -> bool:
    """Fire a sleep-callout ping if local hour ≥ cutoff AND Daniel is
    active in the last 15 min AND we haven't pinged tonight yet.

    Returns True if a ping was sent. Fail-open.
    """
    try:
        s = _settings(db)
        now_local = _local_now(s)
        cutoff_hour = (
            s.sleep_cutoff_hour if s and s.sleep_cutoff_hour is not None
            else _DEFAULT_SLEEP_CUTOFF_HOUR
        )

        # The "night" key spans across midnight — local hour 0..(cutoff+N)
        # belongs to the previous calendar day for idempotency purposes,
        # so we don't fire twice across the midnight rollover. Keep it
        # simple: anchor on yesterday's date when we're in the early
        # AM window.
        if now_local.hour < 12:
            night_key = (now_local.date() - timedelta(days=1)).isoformat()
        else:
            night_key = now_local.date().isoformat()

        # Only fire when we're actually past the cutoff. The cutoff is
        # always a small AM hour (1, 2, 3) — anything before noon and
        # past the cutoff counts. Anything after noon is the previous
        # day's "still up at 1am" trigger that already fired.
        if now_local.hour >= 12:
            return False
        if now_local.hour < cutoff_hour:
            return False

        if s and s.last_sleep_nudge_day == night_key:
            return False
        if not _active_signal_within(db, minutes=15):
            return False

        message = _compose_sleep_message(now_local)
        if not _send_wa(message):
            return False

        if s is not None:
            s.last_sleep_nudge_day = night_key
            db.commit()
        return True
    except Exception as e:
        print(f"[proactive_nudge] sleep nudge errored (ignored): {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return False
