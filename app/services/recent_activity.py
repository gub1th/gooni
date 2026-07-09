"""Recent-activity surface for the master prompt state block.

Daniel called this out 2026-05-22 (WA seg 319 leetcode-finished turn):
state_block tells Gooni what IS right now, but not what just happened.
If the user closes a todo via dashboard at 5:08pm and texts "finished
leetcode" at 5:10pm, Gooni has no idea the closure already landed —
cosine-matches active promises, misses, fires a "couldn't close it"
hallucination.

The fix here is read-only: pull recent updated_at across promises /
promises / focuses / habits / notes, render as natural-language lines
(no raw ids — Daniel's locked feedback memory), inject into state_block
as a "[recent — last 1h]" section. The LLM can reconcile the current
user message against actions it didn't witness.

Cheap query, defensive — each kind wrapped in try/except so one model's
schema drift can't take down the whole block. Cap each kind so the
section stays scannable (max ~8 lines total).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session


_DEFAULT_WINDOW_MIN = 60
_MAX_PER_KIND = {
    "promises": 3,
    "notes": 2,
}
_HARD_LINE_CAP = 8


def _fmt_age(when: datetime, now: datetime) -> str:
    """Human-readable delta. Treats anything ≤60s as 'just now', then
    minutes up to 60, then 'Xh ago' beyond. Caller passes 'now' so all
    lines in one render share the same anchor — avoids the "0m ago"
    vs "1m ago" flicker across lines built ~10ms apart."""
    if when is None:
        return "recently"
    delta = now - when
    secs = int(delta.total_seconds())
    if secs < 0:
        return "just now"
    if secs < 60:
        return "just now"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    hrs = mins // 60
    return f"{hrs}h ago"


def _trim(text: str | None, n: int = 50) -> str:
    s = (text or "").strip()
    if len(s) <= n:
        return s
    return s[:n].rstrip() + "…"



def _recent_promises(db: Session, cutoff: datetime, now: datetime) -> list[tuple[datetime, str]]:
    from ..db.models import Promise

    try:
        rows = (
            db.query(
                Promise.summary,
                Promise.utterance,
                Promise.state,
                Promise.created_at,
                Promise.resolved_at,
                Promise.updated_at,
            )
            .filter(Promise.updated_at >= cutoff)
            .order_by(Promise.updated_at.desc())
            .limit(_MAX_PER_KIND["promises"] * 2)
            .all()
        )
    except Exception as e:
        print(f"[recent_activity] promises query failed: {e}")
        return []

    out: list[tuple[datetime, str]] = []
    for summary, utterance, state, created_at, resolved_at, updated_at in rows:
        text = summary or utterance or ""
        ts = updated_at or created_at
        if ts is None:
            continue
        if state == "kept":
            line = f"promise kept: \"{_trim(text)}\" ({_fmt_age(resolved_at or ts, now)})"
        elif state == "broken":
            line = f"promise broken: \"{_trim(text)}\" ({_fmt_age(resolved_at or ts, now)})"
        elif created_at and created_at >= cutoff:
            line = f"new promise: \"{_trim(text)}\" ({_fmt_age(created_at, now)})"
        else:
            line = f"promise updated: \"{_trim(text)}\" ({_fmt_age(ts, now)})"
        out.append((ts, line))
    return out[: _MAX_PER_KIND["promises"]]




def _recent_notes(db: Session, cutoff: datetime, now: datetime) -> list[tuple[datetime, str]]:
    from ..db.models import Note

    try:
        rows = (
            db.query(Note.title, Note.created_at, Note.updated_at)
            .filter(Note.updated_at >= cutoff)
            .order_by(Note.updated_at.desc())
            .limit(_MAX_PER_KIND["notes"] * 2)
            .all()
        )
    except Exception as e:
        print(f"[recent_activity] notes query failed: {e}")
        return []

    out: list[tuple[datetime, str]] = []
    for title, created_at, updated_at in rows:
        ts = updated_at or created_at
        if ts is None:
            continue
        title_str = title or "untitled"
        verb = "new note" if (created_at and created_at >= cutoff) else "note edited"
        out.append((ts, f"{verb}: \"{_trim(title_str)}\" ({_fmt_age(ts, now)})"))
    return out[: _MAX_PER_KIND["notes"]]


def build_recent_activity_lines(
    db: Session, window_minutes: int = _DEFAULT_WINDOW_MIN
) -> list[str]:
    """Return up to ~8 natural-language activity lines for the past
    `window_minutes`. Sorted newest-first. Empty list when nothing
    happened in the window. NO raw ids in output — per Daniel's
    `feedback_alfred-voice-acks` memory (locked 2026-05-22).
    """
    now = datetime.utcnow()
    cutoff = now - timedelta(minutes=max(1, window_minutes))

    combined: list[tuple[datetime, str]] = []
    combined += _recent_promises(db, cutoff, now)
    combined += _recent_notes(db, cutoff, now)

    combined.sort(key=lambda r: r[0], reverse=True)
    return [line for _, line in combined[:_HARD_LINE_CAP]]
