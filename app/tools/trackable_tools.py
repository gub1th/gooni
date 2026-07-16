"""Trackable chat tools (Slice 6).

`read_trackable` is the recall surface ("how's my cut going" / "what did
whoop say"). `log_trackable_entry` is the deterministic WRITE surface:
Master states a value, Gooni logs it. It replaced the old chat
fitness-INTENT pipeline (the extractor that guessed calories and auto-wrote
DailyMetric rows) — Claude-competitive NLP we cut. Logging is now an
explicit, visible tool call with NO number-guessing: if Master names a food
but no count, the persona tells Gooni to ask, not invent. The web matrix
(/metrics) remains the other write surface.
"""

from __future__ import annotations

from .base import BaseTool


class ReadTrackableTool(BaseTool):
    name = "read_trackable"
    description = (
        "Read Master's trackables — the generic measurement primitive "
        "(calories, protein, weight, substances, whoop, leetcode…). "
        "Empty name lists all definitions; a name returns that "
        "trackable's per-day values for the last N days. Use for 'how's "
        "the cut', 'what's my weight trend', 'whoop numbers'. Read-only."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Trackable name (empty = list all).",
                "default": "",
            },
            "days": {
                "type": "integer",
                "description": "Pivot window in days (default 7, max 60).",
                "default": 7,
            },
        },
        "required": [],
    }

    def execute(self, db=None, name: str = "", days: int = 7, **kwargs) -> str:
        from ..services import trackable_service

        if db is None:
            return "(no db session)"
        days = max(1, min(int(days or 7), 60))
        if not (name or "").strip():
            defs = trackable_service.list_all(db)
            if not defs:
                return "(no trackables)"
            return "\n".join(
                f"- {t.name} ({t.kind}"
                + (f", target {t.target:g}{' ' + t.unit if t.unit else ''}" if t.target is not None else "")
                + ")"
                for t in defs
            )
        t = trackable_service.get_by_name(db, name)
        if t is None:
            return f"(no trackable named {name!r})"
        pivot = trackable_service.pivot(db, t, days=days)
        if not pivot:
            return f"{t.name}: no entries in last {days}d"
        lines = [f"{t.name} ({t.kind}, last {days}d):"]
        for d in pivot:
            lines.append(f"  {d['date']}: {d['value']}")
        return "\n".join(lines)


class LogTrackableEntryTool(BaseTool):
    name = "log_trackable_entry"
    description = (
        "Log a measurement to one of Master's trackables (calories, protein, "
        "weight, exercise, alcohol, weed, vape, or any he defined). Use ONLY "
        "when Master states a value — 'at 1800 cal today', '175 this morning', "
        "'hit legs', 'had a beer'. WHOLE-BASIS: the value SETS the day's total, "
        "it does NOT add to it — so pass the running total he states ('1800 "
        "today' → today = 1800, not +1800), and a later '2100 now' overwrites "
        "it. Log the value HE gave; NEVER invent or estimate a number — if he "
        "names a food but no count, ask him for it instead of calling this. "
        "Numeric trackables take `value`; boolean ones (exercise/substances) "
        "log true when mentioned. Non-system names must already exist (else "
        "say so — Master creates it in the matrix)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Existing trackable name, lowercase (e.g. 'calories', 'weight', 'exercise').",
            },
            "value": {
                "type": "number",
                "description": "Numeric value for a numeric trackable (2100, 175). Omit for a pure boolean log.",
            },
            "boolean": {
                "type": "boolean",
                "description": "For a boolean trackable (exercise/alcohol/weed/vape): true = it happened. Defaults true when the trackable is boolean.",
            },
            "label": {
                "type": "string",
                "description": "Optional tag for a boolean day, e.g. exercise → 'push'/'legs'.",
                "default": "",
            },
            "date": {
                "type": "string",
                "description": "YYYY-MM-DD if Master named a past day ('weighed 175 yesterday'); omit for today.",
                "default": "",
            },
        },
        "required": ["name"],
    }

    def execute(
        self, db=None, name: str = "", value=None, boolean=None,
        label: str = "", date: str = "", **kwargs,
    ) -> str:
        from datetime import date as _date
        from ..services import trackable_service

        if db is None:
            return "(no db session)"
        name = (name or "").strip().lower()
        if not name:
            return "(no trackable name given)"
        t = trackable_service.get_by_name(db, name)
        if t is None:
            # System fitness/body trackables (calories/protein/weight/exercise/
            # substances) must always be loggable — they're the mobile-capture
            # case. Get-or-create them from the canonical defaults; anything
            # else must already exist (Master creates it in the matrix).
            from ..services import daily_metric_service
            if name in daily_metric_service._SYSTEM_DEFS:
                t = daily_metric_service._trackable(db, name)
        if t is None:
            return f"(no trackable named {name!r} — Master creates it in the matrix first)"

        day = None
        if (date or "").strip():
            try:
                day = _date.fromisoformat(date.strip())
            except ValueError:
                day = None  # unparseable → default to today

        vb = vn = vj = None
        if t.kind == "numeric":
            if value is None:
                return f"({name} is numeric — a number is required to log it, sir)"
            try:
                vn = float(value)
            except (TypeError, ValueError):
                return f"(couldn't read {value!r} as a number for {name})"
        elif t.kind == "boolean":
            vb = True if boolean is None else bool(boolean)
            if label and label.strip():
                vj = {"label": label.strip()}  # rides the same row; value_boolean stays true
        else:
            return f"({name} is a {t.kind} trackable — not loggable from chat)"

        try:
            # replace=True → whole-basis: collapse the day to this single value
            # (Master states the running total from chat, not deltas). This
            # differs from the matrix's additive food-item logging on purpose.
            entry = trackable_service.log_entry(
                db, t, day=day,
                value_boolean=vb, value_numeric=vn, value_json=vj,
                source="chat", replace=True,
            )
        except Exception as e:
            return f"(log failed: {e})"
        if entry is None:
            return f"(nothing logged for {name})"

        d = entry.date
        if t.kind == "boolean":
            tag = f" ({label.strip()})" if (label and label.strip()) else ""
            return f"logged {name}{tag} — {d.isoformat()}"
        unit = f" {t.unit}" if t.unit else ""
        return f"set {name} = {vn:g}{unit} for {d.isoformat()}"
