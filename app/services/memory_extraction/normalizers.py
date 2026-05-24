"""Pure dict->dict normalizers for each signal type emitted by
extract_signals. No DB, no LLM, no I/O — just shape coercion + clamping."""

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


def _normalize_promises(items: Any) -> list[dict]:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        utt = it.get("utterance")
        if not (isinstance(utt, str) and utt.strip()):
            continue
        summary = it.get("summary")
        time_hint = it.get("time_hint")
        spawns_raw = it.get("spawns_todo")
        if isinstance(spawns_raw, bool):
            spawns_todo = spawns_raw
        elif isinstance(spawns_raw, str):
            spawns_todo = spawns_raw.strip().lower() == "true"
        else:
            spawns_todo = False
        out.append({
            "utterance": utt.strip()[:500],
            "summary": summary.strip()[:200] if isinstance(summary, str) and summary.strip() else None,
            "time_hint": time_hint.strip()[:60] if isinstance(time_hint, str) and time_hint.strip() and time_hint.strip().lower() != "null" else None,
            "spawns_todo": spawns_todo,
        })
    return out


_VALID_TODO_KINDS = ("create", "delete", "complete", "merge", "edit")
_VALID_EDIT_PATCH_KEYS = (
    "text", "subtitle", "due_hint", "primary",
    "parent_match", "unlink_parent", "position",
    "focus_name",
)


def _normalize_todos(items: Any) -> list[dict]:
    """Normalize todo action entries from the extractor.

    Each entry carries a `kind` (create | delete | complete | merge) + the
    kind-specific payload fields. Defaults to `create` for backwards-compat
    with extractor outputs that pre-date G1.1. Validates per-kind required
    fields and drops malformed entries silently (failure mode: never crash
    the extractor, ever).
    """
    out = []
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
        if kind not in _VALID_TODO_KINDS:
            kind = "create"

        text_raw = it.get("text")
        text = text_raw.strip() if isinstance(text_raw, str) else ""
        match_raw = it.get("match")
        match = match_raw.strip() if isinstance(match_raw, str) else ""
        merge_into_raw = it.get("merge_into")
        merge_into = (
            merge_into_raw.strip()
            if isinstance(merge_into_raw, str)
            else ""
        )

        # Per-kind required-field validation. Drop malformed entries.
        if kind == "create" and not text:
            continue
        if kind in ("delete", "complete", "edit") and not match:
            continue
        if kind == "merge" and (not match or not merge_into):
            continue

        due_hint = it.get("due_hint")

        # G3.5: COMPLETE kind can carry closure_note + spawned follow-ups.
        # Only meaningful when kind=complete; silently dropped for other
        # kinds so the schema stays consistent.
        closure_note_raw = it.get("closure_note") if kind == "complete" else None
        closure_note = (
            closure_note_raw.strip()
            if isinstance(closure_note_raw, str)
            and closure_note_raw.strip()
            and closure_note_raw.strip().lower() != "null"
            else None
        )

        spawned_raw = it.get("spawned") if kind == "complete" else None
        spawned: list[dict] = []
        if isinstance(spawned_raw, list):
            for sp in spawned_raw:
                if not isinstance(sp, dict):
                    continue
                sp_text = sp.get("text")
                if not isinstance(sp_text, str) or not sp_text.strip():
                    continue
                sp_due = sp.get("due_hint")
                spawned.append({
                    "text": sp_text.strip()[:200],
                    "due_hint": (
                        sp_due.strip()[:40]
                        if isinstance(sp_due, str)
                        and sp_due.strip()
                        and sp_due.strip().lower() != "null"
                        else None
                    ),
                })

        # G3.9 EDIT kind: validate + normalize the patch object. Drop
        # unknown keys, coerce types, leave empty values out so handlers
        # know which fields the user actually intended.
        patch_raw = it.get("patch") if kind == "edit" else None
        patch: dict = {}
        if isinstance(patch_raw, dict):
            for k, v in patch_raw.items():
                if k not in _VALID_EDIT_PATCH_KEYS:
                    continue
                if k in ("text", "subtitle", "due_hint", "parent_match", "position", "focus_name") and isinstance(v, str):
                    s = v.strip()
                    if s and s.lower() != "null":
                        patch[k] = s[:200]
                elif k in ("primary", "unlink_parent"):
                    if isinstance(v, bool):
                        patch[k] = v
                    elif isinstance(v, str):
                        patch[k] = v.strip().lower() == "true"
        if kind == "edit" and not patch:
            # Edit with no actionable patch fields is noise — drop.
            continue

        out.append({
            "kind": kind,
            "text": text[:200] if text else None,
            "due_hint": (
                due_hint.strip()[:40]
                if isinstance(due_hint, str)
                and due_hint.strip()
                and due_hint.strip().lower() != "null"
                else None
            ),
            "match": match[:200] if match else None,
            "merge_into": merge_into[:200] if merge_into else None,
            "closure_note": closure_note[:500] if closure_note else None,
            "spawned": spawned,
            "patch": patch if kind == "edit" else None,
        })
    return out


def _normalize_done_signals(items: Any) -> list[dict]:
    """Normalize done_signals entries from the extractor (G3.9 atom #2).
    Each entry is an implicit done-utterance ("just called papi") that
    Gooni should fuzzy-match against an open todo at ≥0.85 cosine and
    auto-close. Bad entries silently dropped.
    """
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        phrase = it.get("phrase")
        match = it.get("match")
        if not (isinstance(phrase, str) and phrase.strip()):
            continue
        if not (isinstance(match, str) and match.strip()):
            continue
        out.append({
            "phrase": phrase.strip()[:200],
            "match": match.strip()[:200],
        })
    return out


_VALID_FITNESS_LOG_TYPES = ("food", "weight", "exercise", "macros_explicit")
_VALID_METRIC_TYPES = ("calories", "protein")


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


def _normalize_fitness(items: Any) -> list[dict]:
    """Normalize fitness_logs entries from the extractor (PR-1 fitness
    pipeline). Each entry logs diet/body/training data → DailyMetric rows.
    Drops malformed entries silently — never crash the extractor.

    Output entry shape:
      {log_type, raw_text, needs_estimation, metrics:[{metric_type,value,unit}],
       weight, weight_unit, exercise_label, correction, correction_target}
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

        correction = _coerce_bool(it.get("correction"))
        ct_raw = it.get("correction_target")
        correction_target = (
            ct_raw.strip().lower()
            if isinstance(ct_raw, str)
            and ct_raw.strip().lower() in (*_VALID_METRIC_TYPES, "weight")
            else None
        )

        # Per-type sanity: drop entries that carry no actionable payload.
        if log_type in ("food", "macros_explicit") and not metrics and not (
            log_type == "food" and _coerce_bool(it.get("needs_estimation"))
        ) and not raw_text:
            continue
        if log_type == "weight" and weight is None:
            continue

        out.append({
            "log_type": log_type,
            "raw_text": raw_text,
            "needs_estimation": _coerce_bool(it.get("needs_estimation")),
            "metrics": metrics,
            "weight": weight,
            "weight_unit": weight_unit,
            "exercise_label": exercise_label,
            "correction": correction,
            "correction_target": correction_target,
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
