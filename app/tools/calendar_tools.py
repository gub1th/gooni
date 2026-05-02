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


class ListUpcomingEventsTool(BaseTool):
    name = "list_upcoming_events"
    description = (
        "List events on Daniel's primary Google Calendar in a time window. "
        "Use this BEFORE update_calendar_event or delete_calendar_event so "
        "you can resolve a name fragment ('tennis') into the event_id those "
        "tools require. Also useful for read-back questions like 'what's on "
        "my calendar tomorrow'. Returns id + summary + start/end per event. "
        "Pass `q` to filter by title text — Google does a fuzzy match on "
        "summary/description/location."
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
                "description": "Window end, same format. Optional — defaults to start + 14 days.",
            },
            "q": {
                "type": "string",
                "description": "Optional title/text filter to narrow the list.",
            },
        },
        "required": ["start"],
    }

    def execute(
        self, db=None, start: str = "", end: str = "", q: str = "", **kwargs
    ) -> str:
        from ..services import google_calendar as gcal

        if db is None:
            return "list_upcoming_events: no db session"
        try:
            start_iso = _coerce_iso(start)
        except ValueError as e:
            return f"list_upcoming_events: bad start — {e}"
        if end:
            try:
                end_iso = _coerce_iso(end)
            except ValueError as e:
                return f"list_upcoming_events: bad end — {e}"
        else:
            dt = datetime.fromisoformat(start_iso)
            end_iso = (dt + timedelta(days=14)).isoformat()
        try:
            items = gcal.list_events(
                db=db,
                time_min_iso=start_iso,
                time_max_iso=end_iso,
                q=q or None,
            )
        except RuntimeError as e:
            return f"list_upcoming_events: {e}. Tell Daniel to connect calendar in Settings."
        except Exception as e:
            return f"list_upcoming_events error: {e}"

        if not items:
            return "No events in that window."
        # Each line is what the LLM needs to resolve a follow-up edit/delete:
        # the event_id (opaque string Google requires) plus enough human
        # context to confirm "is this the one?".
        lines = []
        for ev in items[:25]:
            ev_id = ev.get("id", "")
            summary = ev.get("summary") or "(untitled)"
            start_at = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date") or ""
            end_at = (ev.get("end") or {}).get("dateTime") or (ev.get("end") or {}).get("date") or ""
            lines.append(f"  id={ev_id} | {summary} | {start_at} → {end_at}")
        return f"{len(items)} event(s):\n" + "\n".join(lines)


class UpdateCalendarEventTool(BaseTool):
    name = "update_calendar_event"
    description = (
        "Patch an existing primary-calendar event. Use for 'move tennis to "
        "6pm', 'rename meeting to 1:1 with Maya', 'extend to 7pm'. Resolve "
        "the event_id via list_upcoming_events first if Daniel only gave a "
        "name. Pass only the fields that change — omitted fields are left "
        "untouched. Times follow the same format as create_calendar_event. "
        "If you patch start without end (or vice versa), Google will reject "
        "as inconsistent — pass both when shifting the time."
    )
    parameters = {
        "type": "object",
        "properties": {
            "event_id": {
                "type": "string",
                "description": "Google Calendar event id (from list_upcoming_events).",
            },
            "summary": {"type": "string", "description": "New title."},
            "start": {
                "type": "string",
                "description": "New start. RFC3339 or 'YYYY-MM-DD HH:MM'.",
            },
            "end": {
                "type": "string",
                "description": "New end, same format.",
            },
            "description": {"type": "string", "description": "New body / notes."},
        },
        "required": ["event_id"],
    }

    def execute(
        self,
        db=None,
        event_id: str = "",
        summary: str = "",
        start: str = "",
        end: str = "",
        description: str = "",
        **kwargs,
    ) -> str:
        from ..services import google_calendar as gcal

        if db is None:
            return "update_calendar_event: no db session"
        event_id = (event_id or "").strip()
        if not event_id:
            return "update_calendar_event: event_id required (call list_upcoming_events first)"
        # Empty strings from the LLM mean "leave alone"; only forward fields
        # the caller actually populated.
        kwargs_to_pass: dict = {}
        if summary:
            kwargs_to_pass["summary"] = summary
        if description:
            kwargs_to_pass["description"] = description
        if start:
            try:
                kwargs_to_pass["start_iso"] = _coerce_iso(start)
            except ValueError as e:
                return f"update_calendar_event: bad start — {e}"
        if end:
            try:
                kwargs_to_pass["end_iso"] = _coerce_iso(end)
            except ValueError as e:
                return f"update_calendar_event: bad end — {e}"
        if not kwargs_to_pass:
            return "update_calendar_event: nothing to change"
        try:
            evt = gcal.update_event(db=db, event_id=event_id, **kwargs_to_pass)
        except RuntimeError as e:
            return f"update_calendar_event: {e}. Tell Daniel to connect calendar in Settings."
        except Exception as e:
            return f"update_calendar_event error: {e}"
        link = evt.get("htmlLink") or ""
        title = evt.get("summary") or "(untitled)"
        return f"Updated '{title}'. {link}".strip()


class DeleteCalendarEventTool(BaseTool):
    name = "delete_calendar_event"
    description = (
        "Cancel/delete a primary-calendar event by id. Use for 'cancel "
        "tennis', 'drop the 5pm'. Resolve the event_id via "
        "list_upcoming_events first. Irreversible — only call after Daniel "
        "has confirmed (e.g. 'yes' to 'cancel Tennis at 5pm tomorrow?'). "
        "Returns silently on already-deleted events so re-issues don't error."
    )
    parameters = {
        "type": "object",
        "properties": {
            "event_id": {
                "type": "string",
                "description": "Google Calendar event id (from list_upcoming_events).",
            },
        },
        "required": ["event_id"],
    }

    def execute(self, db=None, event_id: str = "", **kwargs) -> str:
        from ..services import google_calendar as gcal

        if db is None:
            return "delete_calendar_event: no db session"
        event_id = (event_id or "").strip()
        if not event_id:
            return "delete_calendar_event: event_id required (call list_upcoming_events first)"
        try:
            gcal.delete_event(db=db, event_id=event_id)
        except RuntimeError as e:
            return f"delete_calendar_event: {e}. Tell Daniel to connect calendar in Settings."
        except Exception as e:
            return f"delete_calendar_event error: {e}"
        return f"Deleted event {event_id}."


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
