"""Shared singletons + nudge-scheduler helpers.

Lives here (not main.py) so routers can import the nudge fan-out without
creating a router -> main import cycle. App-level depth.
"""
import json

from sqlalchemy.orm import Session

from .db.database import SessionLocal
from .db.models import Settings
from .services.messaging import telegram_channel, whatsapp_channel
from .services.todo_nudge import compose_message as compose_nudge_message

from datetime import datetime as _dt, timedelta as _td

try:
    from zoneinfo import ZoneInfo  # py3.9+
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def _settings_row(db: Session) -> Settings:
    """Singleton accessor. Mirrors todo_nudge._get_settings but local copy
    avoids a cross-module import cycle for the lifespan task."""
    s = db.query(Settings).filter(Settings.id == 1).first()
    if s is None:
        s = Settings(id=1)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def _next_fire(now: _dt, hour: int, minute: int, tz_name: str) -> _dt:
    """Compute the next wall-clock occurrence of HH:MM in tz_name. Returned
    as a tz-aware datetime so subtraction is unambiguous."""
    if ZoneInfo is None:
        # Naïve fallback: assume host is in the right tz. Should never hit
        # this on Fly (3.11) but keeps imports honest on older runtimes.
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += _td(days=1)
        return target
    tz = ZoneInfo(tz_name)
    now_tz = now.astimezone(tz) if now.tzinfo else now.replace(tzinfo=tz)
    target = now_tz.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now_tz:
        target += _td(days=1)
    return target


async def _fire_nudge_once(force: bool = False) -> dict:
    """Build + fan out the digest. Returns a small report dict for callers
    (the test endpoint surfaces it). `force=True` skips the same-day idempotency
    guard so Settings → "Send test now" always fires.
    """
    db = SessionLocal()
    try:
        s = _settings_row(db)
        tz_name = s.nudge_tz or "America/Los_Angeles"
        today_str = _dt.now(ZoneInfo(tz_name) if ZoneInfo else None).strftime("%Y-%m-%d")
        if not force and s.nudge_last_sent_day == today_str:
            return {"sent": False, "reason": "already sent today"}

        msg = compose_nudge_message(db)
        if msg is None:
            # No-news day — still stamp last_sent_day so we don't re-check
            # every minute (the loop sleeps to next-fire after this returns).
            if not force:
                s.nudge_last_sent_day = today_str
                db.commit()
            return {"sent": False, "reason": "no todos or focuses to mention"}

        try:
            channels = json.loads(s.nudge_channels or '["telegram"]')
        except json.JSONDecodeError:
            channels = ["telegram"]

        sent_to: list[str] = []
        skipped: list[str] = []

        if "telegram" in channels:
            for chat_id in telegram_channel.allowed_chat_ids:
                try:
                    formatted = telegram_channel.format_outbound(msg)
                    telegram_channel.send(str(chat_id), formatted)
                    sent_to.append(f"telegram:{chat_id}")
                except Exception as e:
                    print(f"[nudge] telegram send failed for {chat_id}: {e}")

        if "whatsapp" in channels:
            # WA Business API rejects freeform sends outside the 24h
            # customer-initiated window. Single-tenant Gooni: one conversation
            # row per source, so we approximate the window via the most recent
            # WA message timestamp. If silent for >24h, skip — user can DM
            # Gooni any random thing to reopen the window.
            from .db.models import Conversation as _Conv  # local import: tight scope
            cutoff = _dt.utcnow() - _td(hours=24)
            last_wa = (
                db.query(_Conv)
                .filter(_Conv.source == "whatsapp")
                .order_by(_Conv.last_message_at.desc())
                .first()
            )
            wa_open = bool(
                last_wa and last_wa.last_message_at and last_wa.last_message_at >= cutoff
            )
            for handle in sorted({h for h in whatsapp_channel._allowed}):  # type: ignore[attr-defined]
                if not wa_open:
                    skipped.append(f"whatsapp:{handle} (>24h silent — outside window)")
                    continue
                try:
                    formatted = whatsapp_channel.format_outbound(msg)
                    whatsapp_channel.send(handle, formatted)
                    sent_to.append(f"whatsapp:{handle}")
                except Exception as e:
                    print(f"[nudge] whatsapp send failed for {handle}: {e}")

        if not force and sent_to:
            s.nudge_last_sent_day = today_str
            db.commit()

        return {"sent": bool(sent_to), "to": sent_to, "skipped": skipped}
    finally:
        db.close()
