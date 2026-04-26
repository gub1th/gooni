"""Chat-callable wrappers around the Google Calendar service.

The OAuth + create_event/free_busy backend is already built in
app/services/google_calendar.py. These tools just expose it to the LLM.

Date inputs accept either RFC3339 with offset ("2026-05-01T14:00:00-07:00")
or local-shape strings ("2026-05-01 14:00") which we coerce. Coercion is
intentionally simple — Master is in one timezone, the bot lives there too,
and a heavier date library would mask LLM mistakes the user would rather
see flagged.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .base import BaseTool


# Default timezone when LLM omits offset. Hardcoded for Master's location;
# revisit when this becomes a multi-tenant app.
_DEFAULT_TZ = ZoneInfo("America/Los_Angeles")


def _coerce_iso(s: str) -> str:
    """Accept RFC3339 with offset (pass-through) or naive local "YYYY-MM-DD HH:MM"
    / "YYYY-MM-DDTHH:MM". Returns RFC3339 with the default-tz offset.
    Raises ValueError on garbage."""
    s = (s or "").strip()
    if not s:
        raise ValueError("empty datetime")
    # If already has Z or +HH:MM offset, leave alone.
    if s.endswith("Z") or re.search(r"[+-]\d{2}:?\d{2}$", s):
        return s
    # Normalize separator
    s_norm = s.replace(" ", "T")
    # Pad seconds if missing
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", s_norm):
        s_norm += ":00"
    try:
        dt = datetime.fromisoformat(s_norm)
    except ValueError as e:
        raise ValueError(f"unrecognized datetime: {s}") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_DEFAULT_TZ)
    return dt.isoformat()


class CreateCalendarEventTool(BaseTool):
    name = "create_calendar_event"
    description = (
        "Create an event on Daniel's Google Calendar (primary). Use when "
        "Daniel asks to schedule, book, or block time. If end time is "
        "omitted, default to 1 hour after start. Times can be RFC3339 with "
        "offset, or naive local like '2026-05-01 14:00' (treated as Daniel's "
        "local time). If calendar isn't connected, this returns an error — "
        "in that case, tell Daniel to connect it via Settings."
    )
    parameters = {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "description": "Event title (e.g. 'Dentist', 'Lunch with Maya')",
            },
            "start": {
                "type": "string",
                "description": "Start datetime. RFC3339 or 'YYYY-MM-DD HH:MM'.",
            },
            "end": {
                "type": "string",
                "description": "End datetime, same format. Optional — defaults to start + 1h.",
            },
            "description": {
                "type": "string",
                "description": "Optional event body / notes.",
            },
        },
        "required": ["summary", "start"],
    }

    def execute(
        self,
        db=None,
        summary: str = "",
        start: str = "",
        end: str = "",
        description: str = "",
        **kwargs,
    ) -> str:
        from ..services import google_calendar as gcal

        if db is None:
            return "create_calendar_event: no db session"
        summary = (summary or "").strip()
        if not summary:
            return "create_calendar_event: summary required"
        try:
            start_iso = _coerce_iso(start)
        except ValueError as e:
            return f"create_calendar_event: bad start time — {e}"
        if end:
            try:
                end_iso = _coerce_iso(end)
            except ValueError as e:
                return f"create_calendar_event: bad end time — {e}"
        else:
            # Default to start + 1h. Re-parse start as datetime for math.
            dt = datetime.fromisoformat(start_iso)
            end_iso = (dt + timedelta(hours=1)).isoformat()

        try:
            evt = gcal.create_event(
                db=db,
                summary=summary,
                start_iso=start_iso,
                end_iso=end_iso,
                description=description or None,
            )
        except RuntimeError as e:
            # Calendar not connected — surface a clear, actionable string.
            return f"create_calendar_event: {e}. Tell Daniel to connect calendar in Settings."
        except Exception as e:
            return f"create_calendar_event error: {e}"

        link = evt.get("htmlLink") or ""
        return f"Created '{summary}' on {start_iso}. {link}".strip()


class CheckCalendarFreeBusyTool(BaseTool):
    name = "check_calendar_busy"
    description = (
        "Check Daniel's Google Calendar for busy blocks in a time window. "
        "Use when Daniel asks 'am I free at X' or 'what's on my calendar today'. "
        "Returns a short list of busy ranges or 'no busy blocks'. Times follow "
        "the same format as create_calendar_event."
    )
    parameters = {
        "type": "object",
        "properties": {
            "start": {
                "type": "string",
                "description": "Window start. RFC3339 or 'YYYY-MM-DD HH:MM'.",
            },
            "end": {
                "type": "string",
                "description": "Window end, same format.",
            },
        },
        "required": ["start", "end"],
    }

    def execute(
        self, db=None, start: str = "", end: str = "", **kwargs
    ) -> str:
        from ..services import google_calendar as gcal

        if db is None:
            return "check_calendar_busy: no db session"
        try:
            start_iso = _coerce_iso(start)
            end_iso = _coerce_iso(end)
        except ValueError as e:
            return f"check_calendar_busy: {e}"
        try:
            data = gcal.free_busy(db=db, time_min_iso=start_iso, time_max_iso=end_iso)
        except RuntimeError as e:
            return f"check_calendar_busy: {e}. Tell Daniel to connect calendar in Settings."
        except Exception as e:
            return f"check_calendar_busy error: {e}"

        busy = (data.get("calendars") or {}).get("primary", {}).get("busy", [])
        if not busy:
            return "No busy blocks in that window."
        lines = [f"  {b['start']} → {b['end']}" for b in busy[:8]]
        return "Busy blocks:\n" + "\n".join(lines)
