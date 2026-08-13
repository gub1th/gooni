"""Recent-activity surface for the master prompt state block.

Daniel called this out 2026-05-22 (WA seg 319 leetcode-finished turn):
state_block tells Gooni what IS right now, but not what just happened.
If the user closes a promise via the UI at 5:08pm and texts "finished
leetcode" at 5:10pm, Gooni has no idea the closure already landed —
cosine-matches active promises, misses, fires a "couldn't close it"
hallucination. Same hole exists for a run logged in the matrix, a Whoop
sync, etc. — the model can't pull what it doesn't know happened.

The fix is a read-only recency PUSH: the `[recent — last 1h]` block in the
state block. As of the life-log Phase 3 rewrite this is a thin RENDERER over
`activity_service.build_activity_feed` — the SAME union that powers the
always-on activity rail — so the surface Daniel sees and the context Gooni
reads before it answers are one stream (PRD note #397).

Three deliberate narrowings vs the rail:
  - messages are excluded — they're already in Gooni's conversation history,
    so re-pushing them here would just be scrollback;
  - `opened X` device rows are excluded at source — a handful of app/host
    openings is a readable LOG for a human, but it is not state Gooni has to
    reconcile a reply against, and letting them into a ~8-line budget would
    push out the promise and trackable events that are. Excluding at the
    source (rather than returning None from _render) keeps them from eating
    the fetch budget too;
  - the food trackables (calories/protein) are dropped — the food-ledger
    section below surfaces them in richer form, and letting them in would
    double-surface AND eat the ~8-line budget, crowding out promise events;
  - feed lines (Whoop/LeetCode) are stripped to the EVENT ("whoop synced") —
    the numbers stay a pull (Gooni fetches them via read tools if asked).

NO raw ids in the output (Daniel's locked `feedback_alfred-voice-acks`
memory) — verb + quoted text + age is all the LLM needs to reconcile.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session


_DEFAULT_WINDOW_MIN = 60
_HARD_LINE_CAP = 8
# Fetched from the union; messages excluded at source so a chatty hour can't
# starve the state-change lines we actually care about.
_FETCH_LIMIT = 60
# Trackables the food-ledger section already renders in richer form.
_LEDGER_TRACKABLES = {"calories", "protein"}
# Feed-source trackables: collapse to an event, drop the numbers (pull-on-ask).
_FEED_SOURCES = {"whoop", "leetcode", "derived"}


def _fmt_age(when: datetime | None, now: datetime) -> str:
    """Human-readable delta. Treats anything ≤60s as 'just now', then
    minutes up to 60, then 'Xh ago' beyond. Caller passes 'now' so all
    lines in one render share the same anchor — avoids the "0m ago"
    vs "1m ago" flicker across lines built ~10ms apart."""
    if when is None:
        return "recently"
    secs = int((now - when).total_seconds())
    if secs < 60:
        return "just now"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    return f"{mins // 60}h ago"


def _trim(text: str | None, n: int = 50) -> str:
    s = (text or "").strip()
    if len(s) <= n:
        return s
    return s[:n].rstrip() + "…"


def _render(item: dict, now: datetime) -> str | None:
    """Map one activity-feed item → a natural-language line, or None to skip."""
    kind = item.get("kind")
    age = _fmt_age(item.get("at"), now)
    text = _trim(item.get("text"))

    if kind == "promise":
        verb = item.get("verb")
        if verb == "kept":
            return f'promise kept: "{text}" ({age})'
        if verb == "broken":
            return f'promise broken: "{text}" ({age})'
        return f'new promise: "{text}" ({age})'

    if kind == "note":
        verb = "note edited" if item.get("verb") == "edited" else "new note"
        return f'{verb}: "{text}" ({age})'

    if kind == "trackable":
        name = (item.get("name") or "").lower()
        if name in _LEDGER_TRACKABLES:
            return None  # food ledger owns these
        src = item.get("source")
        if src in _FEED_SOURCES:
            # name the subject-day when stale so Gooni doesn't read a day-old
            # Whoop as this morning's (numbers still stay a pull-on-ask)
            lbl = item.get("day_label")
            head = f"{src} ({lbl})" if lbl else src
            return f"{head} synced ({age})"
        return f"logged: {text} ({age})"

    return None


def build_recent_activity_lines(
    db: Session, window_minutes: int = _DEFAULT_WINDOW_MIN
) -> list[str]:
    """Return up to ~8 natural-language activity lines for the past
    `window_minutes`, newest-first. Empty list when nothing happened in the
    window. Thin renderer over the unified activity feed (messages excluded).
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=max(1, window_minutes))

    try:
        from . import activity_service

        feed = activity_service.build_activity_feed(
            db, before=None, limit=_FETCH_LIMIT, exclude_kinds={"message", "device"}
        )
    except Exception as e:  # pragma: no cover — defensive; state block must not die
        print(f"[recent_activity] activity feed failed: {e}")
        return []

    lines: list[str] = []
    for item in feed:  # feed is newest-first
        at = item.get("at")
        if at is None or at < cutoff:
            break
        line = _render(item, now)
        if line:
            lines.append(line)
        if len(lines) >= _HARD_LINE_CAP:
            break
    return lines
