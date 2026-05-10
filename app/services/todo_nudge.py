"""Daily morning digest — user-prompt-driven LLM message.

Daniel writes the instruction for what the daily digest should say (stored on
Settings.nudge_prompt). This module gathers today's data (overdue todos,
due-today todos, top focuses) and asks the LLM to produce ONE conversational
chat message following his prompt. No indexed list, no `done <n>` reply
commands — the message reads like a normal text from Gooni.

Used by the FastAPI lifespan scheduler in app/main.py.
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Focus, Settings, Todo
from app.llm.client import llm_client


# Default prompt — used when Settings.nudge_prompt is empty. Surfaced to the
# UI via /settings/nudge-prompt-default so the "Use default" button can drop
# this exact text into Daniel's textarea.
DEFAULT_PROMPT = (
    "You are Gooni, Daniel's personal AI assistant. Send him a short "
    "good-morning message (2-4 sentences max) that references what he's "
    "actually working on today: any overdue todos, what's due today, and his "
    "top focuses. Be conversational, not corporate. No emoji. No bullet "
    "lists. No greetings like 'Good morning!'. Reference 1-2 specific items "
    "by name when it adds color, but don't list everything — pick what "
    "matters most. If nothing is overdue or due today, mention his focuses "
    "instead and keep it light."
)


def _today_bounds() -> tuple[datetime, datetime]:
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return today, today + timedelta(days=1)


def gather_context(db: Session) -> dict[str, Any]:
    """Pull the data the LLM needs to render a personalized digest.

    Returns a dict with overdue/today todos and active focuses. All lists
    use plain text titles — the LLM doesn't need the full ListItem object.
    Caller is responsible for deciding whether the context is empty enough
    to skip the send entirely (see compose_message)."""
    today, tomorrow = _today_bounds()

    overdue = (
        db.query(Todo)
        .filter(
            Todo.done.is_(False),
            Todo.due_date.is_not(None),
            Todo.due_date < today,
        )
        .order_by(Todo.due_date.asc(), Todo.sort_order.asc())
        .all()
    )
    due_today = (
        db.query(Todo)
        .filter(
            Todo.done.is_(False),
            Todo.due_date.is_not(None),
            Todo.due_date >= today,
            Todo.due_date < tomorrow,
        )
        .order_by(Todo.sort_order.asc())
        .all()
    )

    # Active committed focuses (non-someday).
    focuses = (
        db.query(Focus)
        .filter(
            Focus.committed.is_(True),
            Focus.done.is_(False),
        )
        .order_by(Focus.sort_order.asc())
        .all()
    )

    # Primary now lives on Todo (post-revamp), not Focus. Surface the
    # primary todo separately so the LLM can star it in the digest.
    primary_todo = (
        db.query(Todo)
        .filter(Todo.is_primary.is_(True), Todo.done.is_(False))
        .first()
    )
    return {
        "overdue": [{"text": t.text, "days_late": (today - t.due_date.replace(hour=0, minute=0, second=0, microsecond=0)).days} for t in overdue],
        "today": [{"text": t.text} for t in due_today],
        "focuses": [{"text": f.text} for f in focuses],
        "primary_todo": primary_todo.text if primary_todo else None,
    }


def _has_anything(ctx: dict) -> bool:
    return bool(ctx["overdue"] or ctx["today"] or ctx["focuses"])


def _format_context_block(ctx: dict) -> str:
    """Render the context dict into a plain-text block for the LLM. Same shape
    every fire so Daniel's prompt can rely on the structure."""
    lines: list[str] = []
    if ctx["overdue"]:
        lines.append("OVERDUE:")
        for t in ctx["overdue"]:
            tail = f" ({t['days_late']}d late)" if t["days_late"] > 0 else ""
            lines.append(f"  - {t['text']}{tail}")
    if ctx["today"]:
        lines.append("DUE TODAY:")
        for t in ctx["today"]:
            lines.append(f"  - {t['text']}")
    if ctx.get("primary_todo"):
        lines.append(f"PRIMARY TODO: {ctx['primary_todo']}")
    if ctx["focuses"]:
        lines.append("ACTIVE FOCUSES:")
        for f in ctx["focuses"]:
            lines.append(f"  - {f['text']}")
    if not lines:
        lines.append("(nothing scheduled, no active focuses)")
    return "\n".join(lines)


def compose_message(db: Session) -> str | None:
    """Compose the daily digest message using Daniel's prompt + today's data.

    Returns None when there's truly nothing to nudge about (no todos, no
    focuses) so the caller can skip the send entirely.
    """
    ctx = gather_context(db)
    if not _has_anything(ctx):
        return None

    s = db.query(Settings).filter(Settings.id == 1).first()
    user_prompt = (s.nudge_prompt or "").strip() if s else ""
    instruction = user_prompt or DEFAULT_PROMPT

    context_block = _format_context_block(ctx)
    full_prompt = (
        f"{instruction}\n\n"
        "Use only the data below. Do not invent items.\n\n"
        f"{context_block}"
    )

    try:
        resp = llm_client.client.chat.completions.create(
            model=llm_client.chat_model,
            messages=[{"role": "user", "content": full_prompt}],
            temperature=0.8,
            max_completion_tokens=200,
        )
        msg = (resp.choices[0].message.content or "").strip()
        # Strip surrounding quotes the model loves to add when given a
        # one-message instruction.
        if len(msg) >= 2 and msg[0] in "\"'" and msg[-1] in "\"'":
            msg = msg[1:-1]
        return msg or _fallback(ctx)
    except Exception as e:
        print(f"[nudge] LLM compose failed, using fallback: {e}")
        return _fallback(ctx)


def _fallback(ctx: dict) -> str:
    """Static fallback — never as good as the LLM, but always sends."""
    parts: list[str] = []
    if ctx["overdue"]:
        n = len(ctx["overdue"])
        parts.append(f"{n} thing{'s' if n != 1 else ''} slipped past")
    if ctx["today"]:
        n = len(ctx["today"])
        parts.append(f"{n} due today")
    if not parts:
        if ctx.get("primary_todo"):
            return f"Quiet day on the docket — keep moving on {ctx['primary_todo']}."
        if ctx["focuses"]:
            return f"Quiet day on the docket — focused on {ctx['focuses'][0]['text']}."
        return "Quiet day on the docket."
    return ", ".join(parts).capitalize() + "."
