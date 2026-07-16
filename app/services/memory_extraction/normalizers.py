"""Pure dict->dict normalizers for each signal type emitted by
extract_signals. No DB, no LLM, no I/O — just shape coercion + clamping."""

from datetime import date as _date, timedelta
from typing import Any

from .parsers import _validate_candidate


def _normalize_tone(items: Any) -> list[dict]:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        rule = it.get("rule")
        if not (isinstance(rule, str) and rule.strip()):
            continue
        evidence = it.get("evidence")
        anti_pattern = it.get("anti_pattern")
        out.append({
            "rule": rule.strip()[:240],
            "evidence": evidence.strip()[:240] if isinstance(evidence, str) else "",
            "anti_pattern": anti_pattern.strip()[:240] if isinstance(anti_pattern, str) else "",
        })
    return out


def _normalize_features(items: Any) -> list[dict]:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        title = it.get("title")
        why = it.get("why")
        if isinstance(title, str) and title.strip():
            out.append({
                "title": title.strip()[:120],
                "why": why.strip() if isinstance(why, str) else "",
            })
    return out


def _normalize_memories(items: Any) -> list[dict]:
    if not isinstance(items, list):
        return []
    return [c for c in items if _validate_candidate(c)]


_VALID_PROMISE_KINDS = ("create", "complete", "break")
_VALID_CADENCES = (
    "once", "daily", "n_per_week", "permanent_do", "permanent_never"
)


def _coerce_due_date(raw: Any, today: _date | None = None) -> str | None:
    """Validate an extractor-supplied promise due_date (YYYY-MM-DD).
    Deadlines point FORWARD — accept today..+366d; clamp LLM date-math
    mistakes (past dates, multi-year hallucinations) to None so the
    due_hint regex fallback takes over."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        d = _date.fromisoformat(raw.strip()[:10])
    except ValueError:
        return None
    today = today or _date.today()
    if d < today or d > today + timedelta(days=366):
        return None
    return d.isoformat()


def _coerce_int(v: Any) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 0 < n <= 100 else None


def _normalize_promise_signals(items: Any, today: _date | None = None) -> list[dict]:
    """Normalize the unified `promises` emit (ambient-loop v2 Slice 1 —
    replaces the old soft_promises / todos / done_signals trio).

    Entry shape out:
      {kind, utterance, summary, cadence, cadence_target, due_date,
       due_hint, is_important, parent_hint, match}
    Malformed entries dropped silently — never crash the extractor.
    """
    out: list[dict] = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        kind_raw = it.get("kind")
        kind = (
            kind_raw.strip().lower()
            if isinstance(kind_raw, str) and kind_raw.strip()
            else "create"
        )
        if kind not in _VALID_PROMISE_KINDS:
            kind = "create"

        utt_raw = it.get("utterance")
        utterance = utt_raw.strip()[:500] if isinstance(utt_raw, str) else ""
        match_raw = it.get("match")
        match = match_raw.strip()[:200] if isinstance(match_raw, str) else ""

        # Per-kind required fields.
        if kind == "create" and not utterance:
            continue
        if kind in ("complete", "break") and not match:
            continue

        cadence_raw = it.get("cadence")
        cadence = (
            cadence_raw.strip().lower()
            if isinstance(cadence_raw, str)
            and cadence_raw.strip().lower() in _VALID_CADENCES
            else "once"
        )
        cadence_target = (
            _coerce_int(it.get("cadence_target"))
            if cadence == "n_per_week"
            else None
        )

        summary = it.get("summary")
        due_hint = it.get("due_hint")
        parent_hint = it.get("parent_hint")

        def _opt_str(v: Any, cap: int) -> str | None:
            if isinstance(v, str) and v.strip() and v.strip().lower() != "null":
                return v.strip()[:cap]
            return None

        # Recurring cadences have no single deadline — a due on a daily/
        # weekly promise would get auto_mark_overdue'd into `broken` the
        # day after creation ("gym 6x a week starting today" ≠ due today).
        recurring = cadence != "once"
        out.append({
            "kind": kind,
            "utterance": utterance or None,
            "summary": _opt_str(summary, 200),
            "cadence": cadence,
            "cadence_target": cadence_target,
            "due_date": None if recurring else _coerce_due_date(it.get("due_date"), today),
            "due_hint": None if recurring else _opt_str(due_hint, 60),
            "is_important": _coerce_bool(it.get("is_important")),
            "parent_hint": _opt_str(parent_hint, 200),
            "match": match or None,
        })
    return out


def _coerce_bool(v: Any) -> bool:
    """str-or-bool → bool. Mirrors the spawns_todo coercion idiom."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() == "true"
    return False


def _normalize_reply_intent(value: Any) -> str:
    """Single-of-four classification. Defaults to "answer" — phase 5's
    "skip the LLM reply" gating only fires when we're confident the
    intent is task_only / no_reply; conservative default keeps current
    behavior intact."""
    if not isinstance(value, str):
        return "answer"
    v = value.strip().lower()
    if v in ("answer", "acknowledge", "task_only", "no_reply"):
        return v
    return "answer"
