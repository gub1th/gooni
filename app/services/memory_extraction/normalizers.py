"""Pure dict->dict normalizers for each signal type emitted by
extract_signals. No DB, no LLM, no I/O — just shape coercion + clamping."""

from datetime import date as _date, timedelta
from typing import Any

from .parsers import _validate_candidate


def _coerce_log_date(raw: Any, today: _date | None = None) -> str | None:
    """Validate an extractor-supplied fitness-log date (YYYY-MM-DD). Must
    parse, not be in the future, and not >1yr back — clamps LLM date math
    mistakes. None means "use today" (the handler's default). `today` is the
    user's local date (passed down from extract_signals); falls back to
    date.today() which is server-UTC, so prefer passing it."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        d = _date.fromisoformat(raw.strip()[:10])
    except ValueError:
        return None
    today = today or _date.today()
    if d > today or d < today - timedelta(days=366):
        return None
    return d.isoformat()


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


_VALID_FITNESS_LOG_TYPES = ("food", "weight", "exercise", "macros_explicit", "substance")
_VALID_METRIC_TYPES = ("calories", "protein")
# Substance occurrences flip a boolean cut-table column for today (alcohol/
# weed/vape). DailyMetric only — no Habit; the streak is derived.
_VALID_SUBSTANCES = ("alcohol", "weed", "vape")


def _coerce_bool(v: Any) -> bool:
    """str-or-bool → bool. Mirrors the spawns_todo coercion idiom."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() == "true"
    return False


def _coerce_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _normalize_fitness(items: Any, today: _date | None = None) -> list[dict]:
    """Normalize fitness_logs entries from the extractor (PR-1 fitness
    pipeline). Each entry logs diet/body/training data → DailyMetric rows.
    Drops malformed entries silently — never crash the extractor.

    Output entry shape:
      {log_type, raw_text, needs_estimation, metrics:[{metric_type,value,unit}],
       weight, weight_unit, exercise_label, correction, correction_target,
       correction_scope}
    """
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        lt_raw = it.get("log_type")
        log_type = lt_raw.strip().lower() if isinstance(lt_raw, str) else ""
        if log_type not in _VALID_FITNESS_LOG_TYPES:
            continue

        raw_text_raw = it.get("raw_text")
        raw_text = raw_text_raw.strip()[:500] if isinstance(raw_text_raw, str) else ""

        # Normalize metrics list (only for explicit/correction logs).
        metrics: list[dict] = []
        metrics_raw = it.get("metrics")
        if isinstance(metrics_raw, list):
            for m in metrics_raw:
                if not isinstance(m, dict):
                    continue
                mt_raw = m.get("metric_type")
                mt = mt_raw.strip().lower() if isinstance(mt_raw, str) else ""
                if mt not in _VALID_METRIC_TYPES:
                    continue
                val = _coerce_float(m.get("value"))
                if val is None:
                    continue
                unit_raw = m.get("unit")
                unit = unit_raw.strip()[:16] if isinstance(unit_raw, str) and unit_raw.strip() else None
                metrics.append({"metric_type": mt, "value": val, "unit": unit})

        weight = _coerce_float(it.get("weight")) if log_type == "weight" else None
        wu_raw = it.get("weight_unit")
        weight_unit = (
            wu_raw.strip().lower()[:8]
            if isinstance(wu_raw, str) and wu_raw.strip()
            else "lb"
        ) if log_type == "weight" else None

        ex_raw = it.get("exercise_label") if log_type == "exercise" else None
        exercise_label = ex_raw.strip()[:120] if isinstance(ex_raw, str) and ex_raw.strip() else None

        sub_raw = it.get("substance") if log_type == "substance" else None
        substance = (
            sub_raw.strip().lower()
            if isinstance(sub_raw, str) and sub_raw.strip().lower() in _VALID_SUBSTANCES
            else None
        )

        correction = _coerce_bool(it.get("correction"))
        ct_raw = it.get("correction_target")
        correction_target = (
            ct_raw.strip().lower()
            if isinstance(ct_raw, str)
            and ct_raw.strip().lower() in (*_VALID_METRIC_TYPES, "weight")
            else None
        )
        # item (default) = fix one earlier food; day = reset the whole day's
        # total. "day" routes to set_cell (collapse), so anything we can't
        # confidently read as "day" stays "item" — the safe default.
        cs_raw = it.get("correction_scope")
        correction_scope = (
            cs_raw.strip().lower()
            if isinstance(cs_raw, str) and cs_raw.strip().lower() == "day"
            else "item"
        )

        # Per-type sanity: drop entries that carry no actionable payload.
        if log_type in ("food", "macros_explicit") and not metrics and not (
            log_type == "food" and _coerce_bool(it.get("needs_estimation"))
        ) and not raw_text:
            continue
        if log_type == "weight" and weight is None:
            continue
        if log_type == "substance" and substance is None:
            continue

        out.append({
            "log_type": log_type,
            "raw_text": raw_text,
            "needs_estimation": _coerce_bool(it.get("needs_estimation")),
            "metrics": metrics,
            "weight": weight,
            "weight_unit": weight_unit,
            "exercise_label": exercise_label,
            "substance": substance,
            "log_date": _coerce_log_date(it.get("date"), today),
            "correction": correction,
            "correction_target": correction_target,
            "correction_scope": correction_scope,
        })
    return out


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
