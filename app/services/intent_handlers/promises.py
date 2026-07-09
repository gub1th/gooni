"""Unified promise routing — ambient-loop v2 Slice 1.

Handles the single `promises` emit from extract_signals (which replaced
the old soft_promises / todos / done_signals trio). Three kinds:

  create   → promise_service.create with cadence + due + importance +
             optional parent resolution
  complete → find_active_match → transition kept
  break    → find_active_match → transition broken

Note-save path doesn't have a source_message_id, so promises are skipped
there (per PRD: notes rest as notes — no dispatch at capture time). Only
chat surfaces emit promise routing.
"""

from __future__ import annotations

from datetime import datetime, time as _time, timezone as _tz


def _due_from_signal(sp: dict, utterance: str, db):
    """Resolve the due datetime for a create. Extractor's absolute
    `due_date` (YYYY-MM-DD, already future-clamped by the normalizer)
    wins — anchored to EOD in Daniel's LOCAL day, stored naive UTC.
    The `due_hint` phrase runs through the shared tz-aware parser
    (common.parse_due_hint — regex map + dateparser fallback)."""
    from ...common import local_now, parse_due_hint

    due_date = sp.get("due_date")
    if due_date:
        try:
            d = datetime.strptime(due_date, "%Y-%m-%d").date()
            try:
                tzinfo = local_now(db).tzinfo
                local_eod = datetime.combine(d, _time(23, 59), tzinfo=tzinfo)
                return local_eod.astimezone(_tz.utc).replace(tzinfo=None)
            except Exception:
                return datetime.combine(d, _time(23, 59))
        except ValueError:
            pass

    try:
        return parse_due_hint(sp.get("due_hint"), db=db)
    except Exception:
        return None


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return
    if ctx.source_message_id is None:
        return  # promises need a source utterance

    from .. import promise_service

    for sp in items:
        kind = sp.get("kind") or "create"
        try:
            if kind == "create":
                _handle_create(sp, ctx, result, promise_service)
            elif kind in ("complete", "break"):
                _handle_transition(sp, kind, ctx, result, promise_service)
        except Exception as e:
            print(f"[promises handler] {kind} error: {e}")


def _handle_create(sp: dict, ctx, result, promise_service) -> None:
    utterance = (sp.get("utterance") or "").strip()
    if not utterance:
        return

    inferred = _due_from_signal(sp, utterance, ctx.db)

    parent_id = None
    parent_hint = (sp.get("parent_hint") or "").strip()
    if parent_hint:
        try:
            parent_id = promise_service.resolve_parent_hint(ctx.db, parent_hint)
        except Exception as e:
            print(f"[promises handler] parent resolve error: {e}")

    p = promise_service.create(
        ctx.db,
        utterance=utterance,
        summary=sp.get("summary"),
        source_message_id=ctx.source_message_id,
        inferred_due=inferred,
        cadence=sp.get("cadence") or "once",
        cadence_target=sp.get("cadence_target"),
        is_important=bool(sp.get("is_important")),
        parent_promise_id=parent_id,
    )

    result.captured_promises.append(promise_service.serialize(p))
    result.tools_used.append("router:promise")
    if ctx.on_tool_call:
        try:
            ctx.on_tool_call(
                "router:promise",
                label="Captured promise",
                args={
                    "utterance": utterance,
                    "cadence": p.cadence,
                    "cadence_target": p.cadence_target,
                    "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
                    "slip_count": p.slip_count,
                },
            )
        except Exception as e:
            print(f"[promises handler] trace hook error: {e}")


def _handle_transition(sp: dict, kind: str, ctx, result, promise_service) -> None:
    match = (sp.get("match") or "").strip()
    if not match:
        return

    target_state = "kept" if kind == "complete" else "broken"
    p, ambiguous = promise_service.find_active_match(ctx.db, match)

    if p is None:
        result.failed_promise_actions.append({
            "kind": kind,
            "match": match,
            "candidates": ambiguous,  # non-empty means "which one?"
        })
        return

    p = promise_service.transition(ctx.db, p.id, target_state)
    if p is None:
        return
    entry = promise_service.serialize(p)
    if target_state == "kept":
        result.completed_promises.append(entry)
    else:
        result.broken_promises.append(entry)
    result.tools_used.append(f"router:promise_{kind}")
    if ctx.on_tool_call:
        try:
            ctx.on_tool_call(
                f"router:promise_{kind}",
                label=f"Promise {target_state}",
                args={"match": match, "promise_id": p.id},
            )
        except Exception as e:
            print(f"[promises handler] trace hook error: {e}")
