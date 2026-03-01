from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ..db.database import SessionLocal
from ..db.models import OnboardingState

scheduler = AsyncIOScheduler()


def _parse_time(time_str: str) -> tuple[int, int]:
    """Parse a human time string into (hour, minute).

    Handles: '9am', '9:30am', '8:30pm', '21:00', '09:00'.
    """
    s = time_str.strip().lower()

    if ":" in s:
        left, right = s.split(":", 1)
        hour = int(left)
        if "pm" in right:
            minute = int(right.replace("pm", "").strip())
            if hour != 12:
                hour += 12
        elif "am" in right:
            minute = int(right.replace("am", "").strip())
            if hour == 12:
                hour = 0
        else:
            minute = int(right.strip())
    elif "am" in s or "pm" in s:
        is_pm = "pm" in s
        num = int(s.replace("am", "").replace("pm", "").strip())
        minute = 0
        if is_pm and num != 12:
            hour = num + 12
        elif not is_pm and num == 12:
            hour = 0
        else:
            hour = num
    else:
        hour = int(s)
        minute = 0

    return hour, minute


def _get_checkin_message() -> str:
    hour = datetime.now().hour
    if hour < 12:
        return "Morning check-in 🌅 What are you locking in on today?"
    elif hour < 18:
        return "Afternoon check — how's progress going? What's your next move?"
    else:
        return "Evening check-in 🌙 How'd today go? What did you get done?"


def _send_checkin(transport, user_phone: str) -> None:
    if not transport or not user_phone:
        print("[scheduler] No transport or user_phone — skipping check-in.")
        return
    message = _get_checkin_message()
    try:
        transport.send(user_phone, message)
        print(f"[scheduler] Sent check-in to {user_phone}")
    except Exception as e:
        print(f"[scheduler] Failed to send check-in: {e}")


def schedule_checkins(transport, user_phone: str) -> None:
    """Read OnboardingState and (re)schedule proactive check-in jobs.

    OnboardingState.checkin_time / checkin_frequency are the authoritative
    scheduler config — isolated from LLM memory extraction.
    Safe to call multiple times — existing check-in jobs are replaced.
    """
    db = SessionLocal()
    try:
        state = db.query(OnboardingState).first()
        if not state or not state.is_complete or not state.checkin_time:
            return

        try:
            hour, minute = _parse_time(state.checkin_time)
        except Exception:
            print(f"[scheduler] Could not parse check-in time: {state.checkin_time!r}")
            return

        # Remove existing check-in jobs before re-adding
        for job in scheduler.get_jobs():
            if job.id.startswith("checkin_"):
                job.remove()

        freq = (state.checkin_frequency or "daily").lower()

        if "weekly" in freq:
            trigger_kwargs = {"day_of_week": "mon", "hour": hour, "minute": minute}
            job_id = "checkin_weekly"
        elif "other" in freq:
            trigger_kwargs = {"day": "*/2", "hour": hour, "minute": minute}
            job_id = "checkin_every_other"
        else:
            trigger_kwargs = {"hour": hour, "minute": minute}
            job_id = "checkin_daily"

        scheduler.add_job(
            _send_checkin,
            trigger="cron",
            args=[transport, user_phone],
            id=job_id,
            replace_existing=True,
            **trigger_kwargs,
        )
        print(
            f"[scheduler] Scheduled {freq} check-in at {hour:02d}:{minute:02d} → {user_phone}"
        )
    finally:
        db.close()
