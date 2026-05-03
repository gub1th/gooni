"""Daily morning digest: overdue + due-today todos.

Used by the FastAPI lifespan scheduler (app/main.py) to fan out the digest to
every enabled messaging channel each morning. Telegram + WhatsApp share the
same payload — only the indexed list + reply hint are deterministic; a 1-2
sentence opener is LLM-rewritten so the message doesn't read like cron output.

Reply commands (`done <n>`, `tom <n>`, `kill <n>`) are stashed per-recipient
in `Settings.nudge_last_digests` (JSON) and resolved by `resolve_digest_reply()`.
DB-backed instead of in-memory because the FastAPI process (sender) and the
Telegram bot polling script (reply receiver) run as separate processes per
start.sh — they can't share a Python dict.
"""

import json
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.db.models import ListItem, Settings
from app.llm.client import llm_client
from app.services.list_service import list_service


def _today_bounds() -> tuple[datetime, datetime]:
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return today, today + timedelta(days=1)


def _llm_opener(overdue_count: int, today_count: int, sample_titles: list[str]) -> str:
    """One short, friendly opener line. Falls back to a static string if the
    LLM call fails — never let a flaky completion block the nudge.
    """
    titles = ", ".join(t for t in sample_titles[:3] if t) or "your list"
    prompt = (
        "You are Gooni, Daniel's personal AI assistant, sending him a quick "
        "good-morning Telegram message. Write ONE line (max 14 words) that "
        "feels human — not corporate, not chipper. Reference the count and "
        "maybe one task name if it adds color. No emojis. No greetings like "
        "'good morning'. No 'Daniel,'. Just the line.\n\n"
        f"overdue: {overdue_count}\n"
        f"due today: {today_count}\n"
        f"sample tasks: {titles}\n"
    )
    try:
        resp = llm_client.client.chat.completions.create(
            model=llm_client.chat_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.85,
            max_completion_tokens=40,
        )
        line = (resp.choices[0].message.content or "").strip()
        # Strip surrounding quotes the model loves to add.
        if len(line) >= 2 and line[0] in "\"'" and line[-1] in "\"'":
            line = line[1:-1]
        return line or _fallback_opener(overdue_count, today_count)
    except Exception as e:
        print(f"[nudge] LLM opener failed, using fallback: {e}")
        return _fallback_opener(overdue_count, today_count)


def _fallback_opener(overdue: int, today: int) -> str:
    if overdue and today:
        return f"{overdue} overdue, {today} on deck for today."
    if overdue:
        return f"{overdue} thing{'s' if overdue != 1 else ''} slipped past — quick triage?"
    return f"{today} thing{'s' if today != 1 else ''} due today."


def build_nudge_message(db: Session) -> tuple[str, list[int]] | None:
    """Compose the digest plus the ordered list of todo IDs it references.

    Returns None when there's nothing to nudge about so the caller can skip
    the send entirely (no-news = no message).

    The returned id-list is parallel to the 1-based indices printed in the
    message — the caller stashes it so reply-back commands like `done 2`
    can resolve to a real todo without re-querying.
    """
    today, tomorrow = _today_bounds()
    todo_list = list_service.get_or_create_todo_list(db)

    overdue = (
        db.query(ListItem)
        .filter(
            ListItem.list_id == todo_list.id,
            ListItem.done.is_(False),
            ListItem.due_date.is_not(None),
            ListItem.due_date < today,
        )
        .order_by(ListItem.due_date.asc(), ListItem.sort_order.asc())
        .all()
    )
    due_today = (
        db.query(ListItem)
        .filter(
            ListItem.list_id == todo_list.id,
            ListItem.done.is_(False),
            ListItem.due_date.is_not(None),
            ListItem.due_date >= today,
            ListItem.due_date < tomorrow,
        )
        .order_by(ListItem.sort_order.asc())
        .all()
    )

    if not overdue and not due_today:
        return None

    sample_titles = [t.text for t in overdue[:2] + due_today[:2]]
    opener = _llm_opener(len(overdue), len(due_today), sample_titles)

    lines: list[str] = [opener, ""]

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


def _get_settings(db: Session) -> Settings:
    """Singleton accessor — creates row id=1 with defaults if missing.
    Hot path on every nudge fire and reply, so we keep it terse.
    """
    s = db.query(Settings).filter(Settings.id == 1).first()
    if s is None:
        s = Settings(id=1)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def remember_digest(channel: str, recipient: str, ordered_ids: list[int], db: Session) -> None:
    """Persist the (channel, recipient) → ordered_ids mapping in Settings JSON.
    Caller commits — we mutate and return.
    """
    s = _get_settings(db)
    try:
        bag = json.loads(s.nudge_last_digests or "{}")
    except json.JSONDecodeError:
        bag = {}
    bag.setdefault(channel, {})[recipient] = ordered_ids
    s.nudge_last_digests = json.dumps(bag)
    db.commit()


def resolve_digest_reply(
    channel: str,
    recipient: str,
    cmd: str,
    indices: list[int],
    db: Session,
) -> str:
    """Run a digest reply command. Returns the human-readable result string
    (also persists the changes via `db.commit()`).
    """
    s = _get_settings(db)
    try:
        bag = json.loads(s.nudge_last_digests or "{}")
    except json.JSONDecodeError:
        bag = {}
    ordered_ids = bag.get(channel, {}).get(recipient, [])
    if not ordered_ids:
        return (
            "no recent digest to act on — wait for tomorrow's ping (or fire a "
            "test from Settings)."
        )

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)

    results: list[str] = []
    for idx in indices:
        if idx < 1 or idx > len(ordered_ids):
            results.append(f"#{idx} out of range")
            continue
        tid = ordered_ids[idx - 1]
        t = db.query(ListItem).filter(ListItem.id == tid).first()
        if not t:
            results.append(f"#{idx} not found (deleted?)")
            continue
        if cmd == "done":
            if not t.done:
                t.done = True
                t.completed_at = datetime.utcnow()
            results.append(f"✓ {t.text}")
        elif cmd == "tom":
            t.due_date = tomorrow
            results.append(f"→ tomorrow: {t.text}")
        elif cmd == "kill":
            results.append(f"× {t.text}")
            db.delete(t)
    db.commit()
    return "\n".join(results) if results else "(no-op)"
