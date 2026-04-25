"""Daily morning digest: overdue + due-today todos.

Hand-rolled scheduling (asyncio.sleep until the next target time) — APScheduler
is intentionally avoided per CLAUDE.md. Single ping per day, only when there's
something to surface; otherwise silent.
"""

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.db.models import TodoItem


def _today_bounds() -> tuple[datetime, datetime]:
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return today, today + timedelta(days=1)


def build_nudge_message(db: Session) -> tuple[str, list[int]] | None:
    """Compose the digest plus the ordered list of todo IDs it references.

    Returns None when there's nothing to nudge about so the caller can skip
    the send entirely (no-news = no message).

    The returned id-list is parallel to the 1-based indices printed in the
    message — the caller stashes it so reply-back commands like `done 2`
    can resolve to a real todo without re-querying.
    """
    today, tomorrow = _today_bounds()

    overdue = (
        db.query(TodoItem)
        .filter(
            TodoItem.done.is_(False),
            TodoItem.due_date.is_not(None),
            TodoItem.due_date < today,
        )
        .order_by(TodoItem.due_date.asc(), TodoItem.sort_order.asc())
        .all()
    )
    due_today = (
        db.query(TodoItem)
        .filter(
            TodoItem.done.is_(False),
            TodoItem.due_date.is_not(None),
            TodoItem.due_date >= today,
            TodoItem.due_date < tomorrow,
        )
        .order_by(TodoItem.sort_order.asc())
        .all()
    )

    if not overdue and not due_today:
        return None

    total = len(overdue) + len(due_today)
    lines: list[str] = []
    lines.append(f"{total} todo{'s' if total != 1 else ''} on the slate.")
    lines.append("")

    n = 0
    if overdue:
        lines.append("OVERDUE")
        for t in overdue:
            n += 1
            due_day = t.due_date.replace(hour=0, minute=0, second=0, microsecond=0)
            days_late = (today - due_day).days
            tail = f"  ({days_late}d late)" if days_late > 0 else ""
            lines.append(f"  {n}. {t.text}{tail}")
        lines.append("")

    if due_today:
        lines.append("TODAY")
        for t in due_today:
            n += 1
            lines.append(f"  {n}. {t.text}")
        lines.append("")

    lines.append("reply: done <n> · tom <n> · kill <n>")

    ordered_ids = [t.id for t in (list(overdue) + list(due_today))]
    return "\n".join(lines).rstrip(), ordered_ids


def seconds_until_next(target_hour: int = 9, target_minute: int = 0) -> float:
    """Wall-clock seconds from now until the next occurrence of HH:MM local."""
    now = datetime.now()
    target = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()
