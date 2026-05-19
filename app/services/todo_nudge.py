"""Daily morning digest — promise-first conversational nudge.

POST-PROMISES-LAYER REWRITE: the old version dumped today's overdue +
due-today + open-no-due-date todos into the LLM and asked it to summarize.
Daniel called the result "bs" — felt corporate, listy, and made him avoid
the message entirely.

New flow:
  1. Sweep pending promises whose inferred_due is past → auto-mark broken.
  2. Pick ONE live promise to ask about (closest due-within-24h, then any
     pending promise w/ no due, then most-recent slip-counted one).
  3. If no promises at all → fall back to ONE overdue / primary todo
     (kept conversational, never a list).
  4. LLM composes ONE chat-shaped message asking about that one thing.

Voice rules in the LLM prompt: text like a sharp friend, not a manager.
No bullets. No "Good morning!". Reference the verbatim utterance when
asking about a promise — keeps Daniel's words in the loop and makes the
follow-up feel like a real callback ("you said 'imma finish that DSA
video' — howd it land?").

Used by the FastAPI lifespan scheduler in app/main.py.
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Promise, Settings, Todo
from app.llm.client import llm_client
from . import promise_service


# Cap on how many open-no-due-date todos we surface. The LLM picks 1-2 to
# name-drop; more than 5 is wasted prompt context.
_OPEN_TODO_CAP = 5


# Default prompt — used when Settings.nudge_prompt is empty. Surfaced to the
# UI via /settings/nudge-prompt-default so the "Use default" button can drop
# this exact text into Daniel's textarea.
DEFAULT_PROMPT = (
    "You are Gooni — Daniel's accountability partner over WhatsApp. Write "
    "ONE short conversational message asking him about a specific thing "
    "he said he'd do. Voice = sharp friend texting, not corporate. Rules: "
    "no greetings like 'Good morning!', no bullets, no lists, no emoji. "
    "Reference his verbatim words when you have them ('you said \"X\" — "
    "howd it land?'). If he's slipped on this same thing before, name "
    "that fact directly but without judgment ('this is the 3rd time you "
    "said this — wanna retire it or take another swing?'). Max 2 short "
    "sentences. If the picked item is a todo (not a promise), nudge "
    "lightly without listing other todos. End-state vibe: a friend who "
    "kept track and is genuinely curious how it went."
)


def _today_bounds() -> tuple[datetime, datetime]:
    now = datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return today, today + timedelta(days=1)


def gather_context(db: Session) -> dict[str, Any]:
    """Pull the data the LLM needs to render a personalized digest.

    Returns a dict with three todo buckets: overdue, due-today, and a small
    slice of open-no-due-date todos so a digest still has material on a day
    where nothing is explicitly scheduled (most of Daniel's todos carry no
    due_date, so omitting this bucket left the nudge effectively empty).
    Caller is responsible for deciding whether the context is empty enough
    to skip the send entirely (see compose_message)."""
    today, tomorrow = _today_bounds()

    overdue = (
        db.query(Todo)
        .filter(
            Todo.done.is_(False),
            Todo.due_date.is_not(None),
            Todo.due_date < today,
            Todo.deleted_at.is_(None),
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
            Todo.deleted_at.is_(None),
        )
        .order_by(Todo.sort_order.asc())
        .all()
    )

    # Open todos with no due_date. Capped — surfacing 30+ items would dump
    # the whole backlog into every digest. Primary-first so the singleton
    # gets prioritized; ties broken by manual sort_order.
    open_no_due = (
        db.query(Todo)
        .filter(
            Todo.done.is_(False),
            Todo.due_date.is_(None),
            Todo.deleted_at.is_(None),
        )
        .order_by(Todo.is_primary.desc(), Todo.sort_order.asc(), Todo.id.asc())
        .limit(_OPEN_TODO_CAP)
        .all()
    )

    # Primary singleton, surfaced separately so the LLM can star it even
    # when it's also in overdue / today / open buckets.
    primary_todo = (
        db.query(Todo)
        .filter(
            Todo.is_primary.is_(True),
            Todo.done.is_(False),
            Todo.deleted_at.is_(None),
        )
        .first()
    )
    return {
        "overdue": [
            {
                "text": t.text,
                "days_late": (
                    today
                    - t.due_date.replace(hour=0, minute=0, second=0, microsecond=0)
                ).days,
            }
            for t in overdue
        ],
        "today": [{"text": t.text} for t in due_today],
        "open": [{"text": t.text} for t in open_no_due],
        "primary_todo": primary_todo.text if primary_todo else None,
    }


def _has_anything(ctx: dict) -> bool:
    return bool(ctx["overdue"] or ctx["today"] or ctx["open"])


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
    if ctx["open"]:
        lines.append("OPEN (no due date):")
        for t in ctx["open"]:
            lines.append(f"  - {t['text']}")
    if not lines:
        lines.append("(nothing scheduled, no open todos)")
    return "\n".join(lines)


def _pick_focus_item(db: Session) -> dict[str, Any] | None:
    """Pick the ONE thing to nudge about. Priority order:

      1. A pending promise that's due within the next 24h (or overdue
         since the auto-mark sweep just flipped past-due ones to broken,
         so anything in 'pending' is still alive).
      2. Any pending promise — even with no inferred_due, the act of
         saying it out loud earns a check-in.
      3. The primary todo, if set.
      4. The single most-overdue todo, if any.

    Returns a dict shaped {kind, ...item fields} or None when nothing
    qualifies (truly quiet day → skip the send).
    """
    today, tomorrow = _today_bounds()
    cutoff_soon = tomorrow + timedelta(days=1)

    # Promise tier — sweep stale pending → broken before picking so a
    # dead promise doesn't become today's check-in.
    promise_service.auto_mark_overdue(db, now=datetime.utcnow())

    pending = (
        db.query(Promise)
        .filter(Promise.state == "pending")
        .order_by(Promise.inferred_due.asc().nullslast(), Promise.created_at.desc())
        .all()
    )
    for p in pending:
        if p.inferred_due is None:
            continue
        if p.inferred_due < cutoff_soon:
            return {
                "kind": "promise",
                "utterance": p.utterance,
                "summary": p.summary or p.utterance,
                "slip_count": p.slip_count,
                "due_iso": p.inferred_due.isoformat(),
            }
    if pending:
        p = pending[0]
        return {
            "kind": "promise",
            "utterance": p.utterance,
            "summary": p.summary or p.utterance,
            "slip_count": p.slip_count,
            "due_iso": p.inferred_due.isoformat() if p.inferred_due else None,
        }

    # Todo tier — primary first, then most-overdue.
    primary = (
        db.query(Todo)
        .filter(
            Todo.is_primary.is_(True),
            Todo.done.is_(False),
            Todo.deleted_at.is_(None),
        )
        .first()
    )
    if primary:
        return {
            "kind": "todo",
            "subkind": "primary",
            "text": primary.text,
        }

    overdue_top = (
        db.query(Todo)
        .filter(
            Todo.done.is_(False),
            Todo.due_date.is_not(None),
            Todo.due_date < today,
            Todo.deleted_at.is_(None),
        )
        .order_by(Todo.due_date.asc())
        .first()
    )
    if overdue_top:
        days_late = (
            today - overdue_top.due_date.replace(hour=0, minute=0, second=0, microsecond=0)
        ).days
        return {
            "kind": "todo",
            "subkind": "overdue",
            "text": overdue_top.text,
            "days_late": days_late,
        }

    return None


def _format_focus_block(focus: dict[str, Any]) -> str:
    """Render the picked item as a small block for the LLM. Tight; the
    prompt is doing the heavy lifting on voice."""
    if focus["kind"] == "promise":
        lines = [
            "PICKED ITEM: promise (Daniel committed to himself in chat)",
            f"  verbatim utterance: \"{focus['utterance']}\"",
            f"  short summary: {focus['summary']}",
        ]
        if focus.get("due_iso"):
            lines.append(f"  inferred due: {focus['due_iso']}")
        if focus.get("slip_count"):
            lines.append(f"  slip_count: {focus['slip_count']} (he's said variations of this and not followed through this many times)")
        return "\n".join(lines)
    # todo
    sub = focus.get("subkind")
    lines = ["PICKED ITEM: todo (manual list item, not uttered)"]
    lines.append(f"  text: {focus['text']}")
    if sub == "primary":
        lines.append("  note: this is his pinned primary todo")
    elif sub == "overdue":
        lines.append(f"  note: {focus.get('days_late', 0)} days overdue")
    return "\n".join(lines)


def compose_message(db: Session) -> str | None:
    """Compose the daily nudge — ONE conversational chat message asking
    Daniel about ONE specific thing. Returns None when there's truly
    nothing to nudge about so the caller skips the send.
    """
    focus = _pick_focus_item(db)
    if focus is None:
        return None

    s = db.query(Settings).filter(Settings.id == 1).first()
    user_prompt = (s.nudge_prompt or "").strip() if s else ""
    instruction = user_prompt or DEFAULT_PROMPT

    focus_block = _format_focus_block(focus)
    full_prompt = (
        f"{instruction}\n\n"
        "Use only the data below. Do not invent items. Stay on this one item.\n\n"
        f"{focus_block}"
    )

    try:
        resp = llm_client.client.chat.completions.create(
            model=llm_client.chat_model,
            messages=[{"role": "user", "content": full_prompt}],
            temperature=0.8,
            max_completion_tokens=160,
        )
        msg = (resp.choices[0].message.content or "").strip()
        if len(msg) >= 2 and msg[0] in "\"'" and msg[-1] in "\"'":
            msg = msg[1:-1]
        return msg or _fallback(focus)
    except Exception as e:
        print(f"[nudge] LLM compose failed, using fallback: {e}")
        return _fallback(focus)


def _fallback(focus: dict[str, Any]) -> str:
    """Static fallback when the LLM call dies. Single sentence, same
    voice — never resort to bullet dump."""
    if focus["kind"] == "promise":
        slip = focus.get("slip_count", 0) or 0
        utter = focus["utterance"]
        if slip > 0:
            return (
                f"you said \"{utter}\" — this is the {slip + 1}th go at this. "
                "still on, or want to retire it?"
            )
        return f"you said \"{utter}\" — still on?"
    sub = focus.get("subkind")
    text = focus["text"]
    if sub == "overdue":
        return f"\"{text}\" has been sitting — alive or kill it?"
    return f"quiet day on the docket — still chewing on \"{text}\"?"
