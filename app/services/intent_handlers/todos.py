"""Todo routing — extracted chore-shaped tasks become Todo rows.

Cosine-dedups against existing open todos before insert: paraphrases like
"call dentist tomorrow" and "remind me to call dentist" should merge, not
pile up. Threshold 0.85 — same bar as promise active-pending dedup, must
be near-paraphrase.

Surface rules (enforced by the prompt, not here):
  - note-save path: emits todos freely for chore-shaped imperatives
  - chat path: emits soft_promises for "imma X" / "i'll X" commitments;
    todos only on explicit "todo: X" / "remind me to X" phrasing
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

DEDUP_THRESHOLD = 0.85


_DUE_HINTS = {
    "tonight": ("today_eod", None),
    "today": ("today_eod", None),
    "tomorrow": ("plus_days", 1),
    "this week": ("plus_days", 7),
}


def _parse_due(hint: str | None) -> datetime | None:
    if not hint:
        return None
    h = hint.strip().lower()
    rule = _DUE_HINTS.get(h)
    if not rule:
        return None
    kind, arg = rule
    now = datetime.utcnow()
    if kind == "today_eod":
        return now.replace(hour=23, minute=59, second=0, microsecond=0)
    if kind == "plus_days" and isinstance(arg, int):
        return (now + timedelta(days=arg)).replace(
            hour=23, minute=59, second=0, microsecond=0
        )
    return None


def _find_open_duplicate(sess, vec: list[float], todo_service):
    """Cosine-match the candidate against open todos. Returns (Todo, score)
    or (None, 0.0). Tuple-walks (id, text_embed) via list_service helper to
    avoid hydrating all rows."""
    from ..list_service import _cosine, list_service

    open_todos = todo_service.list_open(sess)
    best = None
    best_score = 0.0
    for t in open_todos:
        emb = list_service._embed_item_text(t.text)
        if not emb:
            continue
        score = _cosine(vec, emb)
        if score >= DEDUP_THRESHOLD and score > best_score:
            best = t
            best_score = score
    return best, best_score


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return

    from ..list_service import list_service
    from ..todo_service import todo_service

    for it in items:
        text = (it.get("text") or "").strip()
        if not text:
            continue
        due_at = _parse_due(it.get("due_hint"))

        # Cosine dedup against open todos. Cheap to compute the candidate
        # embedding once, then walk open todos with cached embeds.
        vec = list_service._embed_item_text(text)
        if vec:
            existing, score = _find_open_duplicate(ctx.db, vec, todo_service)
            if existing is not None:
                # Idempotent re-utterance — log the trace, don't create dupe.
                if ctx.on_tool_call:
                    try:
                        ctx.on_tool_call(
                            "router:todo_dedup",
                            label=f"Todo dedup hit (cosine={score:.2f})",
                            args={"new": text, "matched": existing.text, "id": existing.id},
                        )
                    except Exception as e:
                        print(f"[todos handler] trace hook error: {e}")
                continue

        try:
            todo = todo_service.create(
                ctx.db,
                text=text,
                due_date=due_at,
                source_note_id=ctx.source_note_id,
            )
        except Exception as e:
            print(f"[todos handler] create error: {e}")
            continue
        result.tools_used.append("router:todo")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:todo",
                    label="Captured todo",
                    args={
                        "text": text,
                        "due_hint": it.get("due_hint"),
                        "todo_id": todo.id,
                    },
                )
            except Exception as e:
                print(f"[todos handler] trace hook error: {e}")
