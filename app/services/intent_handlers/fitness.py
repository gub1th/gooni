"""Fitness-log routing (PR-1 fitness pipeline).

Turns extractor `fitness_logs` entries into DailyMetric rows in real time
and stamps the running daily total onto RouterResult.captured_metrics so
the ack reads "noted, sir. 1,165 cal, 77g so far today."

Two-tier by design: the extractor already classified the message (Tier 1,
no extra call). This handler only fires a SECOND LLM call for food logs
that carry no numbers (needs_estimation=true) — weight / exercise /
explicit-macros add zero LLM cost.

Unlike promises, fitness logs are valid from the note-save path too
(source_message_id may be None) — Daniel can log a meal in a note. So we
do NOT early-return on a missing source message.
"""

from __future__ import annotations

from datetime import date as _date


def _entry_day(entry: dict, db) -> _date:
    """The calendar day a fitness log lands on: the extractor-resolved
    `log_date` (validated YYYY-MM-DD, e.g. from "weighed 70.8 yesterday"),
    or today (in Daniel's TZ) when none was given. Backdating writes to the
    right cell instead of stamping everything as today. local_today (not
    date.today) so a 6pm-PT log doesn't land on tomorrow's UTC date."""
    raw = entry.get("log_date")
    if isinstance(raw, str) and raw:
        try:
            return _date.fromisoformat(raw)
        except ValueError:
            pass
    from ...common import local_today
    return local_today(db)


def handle(items: list[dict], ctx, result) -> None:
    if not items:
        return

    from .. import daily_metric_service, habit_service

    logged_any = False

    for entry in items:
        log_type = entry.get("log_type")
        try:
            if log_type in ("food", "macros_explicit"):
                logged_any = _handle_macros(ctx, result, entry, daily_metric_service) or logged_any
            elif log_type == "weight":
                logged_any = _handle_weight(ctx, result, entry, daily_metric_service) or logged_any
            elif log_type == "exercise":
                logged_any = _handle_exercise(ctx, result, entry, daily_metric_service, habit_service) or logged_any
            elif log_type == "substance":
                logged_any = _handle_substance(ctx, result, entry, daily_metric_service) or logged_any
        except Exception as e:
            print(f"[fitness handler] entry error ({log_type}): {e}")
            continue

    if not logged_any:
        return

    # Stamp the running daily total onto every metric entry so the ack +
    # just_extracted blocks can render "X cal, Yg so far today" off the
    # freshest entry without re-querying.
    try:
        totals = daily_metric_service.running_total_for_today(ctx.db)
    except Exception as e:
        print(f"[fitness handler] running total failed: {e}")
        totals = {"calories": 0.0, "protein": 0.0}
    for m in result.captured_metrics:
        m["running_calories"] = totals.get("calories", 0.0)
        m["running_protein"] = totals.get("protein", 0.0)

    result.tools_used.append("router:fitness")
    if ctx.on_tool_call:
        try:
            ctx.on_tool_call(
                "router:fitness",
                label="Logged fitness metric(s)",
                args={
                    "count": len(result.captured_metrics),
                    "running_calories": totals.get("calories", 0.0),
                    "running_protein": totals.get("protein", 0.0),
                },
            )
        except Exception as e:
            print(f"[fitness handler] trace hook error: {e}")


def _handle_macros(ctx, result, entry, dms) -> bool:
    """Food (estimate macros) or explicit-macros (parse directly), incl.
    the correction flow. Returns True if any row was written."""
    metrics = entry.get("metrics") or []

    # Tier-2: food with no numbers → one cheap estimation call.
    if not metrics and entry.get("needs_estimation"):
        est = _estimate_macros(entry.get("raw_text") or "")
        if est:
            metrics = est

    if not metrics:
        return False

    correction = bool(entry.get("correction"))
    correction_target = entry.get("correction_target")
    scope = entry.get("correction_scope") or "item"
    raw_text = entry.get("raw_text") or None
    day = _entry_day(entry, ctx.db)
    wrote = False
    # This entry's own cal/protein delta, so the ack can name the item
    # ("noted — popcorn +50 cal") instead of only nudging the opaque total —
    # a silently dropped/misvalued food then shows in the ack (conv #1398).
    item_cal = 0.0
    item_prot = 0.0

    for m in metrics:
        mt = m.get("metric_type")
        val = m.get("value")
        unit = m.get("unit") or ("kcal" if mt == "calories" else "g")
        if mt not in ("calories", "protein") or val is None:
            continue
        if mt == "calories":
            item_cal += float(val)
        elif mt == "protein":
            item_prot += float(val)
        # Three intents (see prompts.py CORRECTIONS):
        #   day-scope correction → RESET the day. set_cell collapses (day, mt)
        #     to one canonical row, so a restated total lands exactly with no
        #     compounding (this is the running-total-explosion fix). Later
        #     meal logs append on top of the reset baseline.
        #   item-scope correction → amend the most-recent matching row; fall
        #     back to a fresh log if there's nothing to correct yet that day.
        #   no correction → additive meal log.
        if correction and scope == "day":
            dms.set_cell(ctx.db, day, mt, value=val, unit=unit, notes=raw_text)
        elif correction and (correction_target in (None, mt)):
            updated = dms.update_most_recent(ctx.db, mt, val, day=day)
            if updated is None:
                dms.log(ctx.db, mt, val, unit=unit, day=day, notes=raw_text)
        else:
            dms.log(ctx.db, mt, val, unit=unit, day=day, notes=raw_text)
        wrote = True

    if wrote:
        result.captured_metrics.append({
            "log_type": entry.get("log_type"),
            "correction": correction,
            "item_label": (raw_text or "").strip() or None,
            "item_calories": round(item_cal, 1) if item_cal else None,
            "item_protein": round(item_prot, 1) if item_prot else None,
        })
    return wrote


_VALID_SUBSTANCES = ("alcohol", "weed", "vape")


def _handle_substance(ctx, result, entry, dms) -> bool:
    """Substance occurrence ("i smoked", "had a few beers", "hit the pen")
    → flip TODAY's DailyMetric boolean (the cut-table column). set_cell
    collapses the (date, type), so saying it twice in a day stays one row
    (it's a boolean — no double-count). DailyMetric ONLY: no Habit row; a
    "days clean" streak is DERIVED from row history if/when surfaced.
    Positive occurrences only — we don't log "stayed sober" (absence is the
    default empty cell)."""
    sub = (entry.get("substance") or "").strip().lower()
    if sub not in _VALID_SUBSTANCES:
        return False
    dms.set_cell(ctx.db, _entry_day(entry, ctx.db), sub, value=1.0, notes=entry.get("raw_text") or None)
    result.captured_metrics.append({"log_type": "substance", "substance": sub})
    return True


def _handle_weight(ctx, result, entry, dms) -> bool:
    val = entry.get("weight")
    if val is None:
        return False
    unit = entry.get("weight_unit") or "lb"
    correction = bool(entry.get("correction"))
    day = _entry_day(entry, ctx.db)
    if correction:
        updated = dms.update_most_recent(ctx.db, "weight", val, day=day)
        if updated is None:
            dms.log(ctx.db, "weight", val, unit=unit, day=day, notes=entry.get("raw_text") or None)
    else:
        dms.log(ctx.db, "weight", val, unit=unit, day=day, notes=entry.get("raw_text") or None)
    result.captured_metrics.append({
        "log_type": "weight",
        "value": val,
        "unit": unit,
        "correction": correction,
    })
    return True


def _handle_exercise(ctx, result, entry, dms, habit_service) -> bool:
    label = entry.get("exercise_label") or (entry.get("raw_text") or None)
    day = _entry_day(entry, ctx.db)
    # value=1.0 is a presence sentinel — the cut table treats exercise as a
    # boolean (did/didn't train); `notes` carries the human label (the
    # activity + any sub-detail: "gym — chest and tris", "tennis", "5k run").
    dms.log(ctx.db, "exercise", 1.0, unit=None, day=day, notes=label)

    # Dual-write a single generic `exercise` boolean habit so "how often did
    # I train" is one streak across ALL modalities (gym/tennis/run) — what
    # Daniel actually wants to see. The specific activity lives in the label,
    # not in separate per-activity habits (those would fragment the count).
    # Isolated try/except — a habit failure must never roll back the metric
    # row (metric is the cut-table source of truth).
    try:
        _upsert_exercise_habit(ctx.db, habit_service, label, day)
    except Exception as e:
        print(f"[fitness handler] exercise habit upsert failed: {e}")

    result.captured_metrics.append({
        "log_type": "exercise",
        "exercise_label": label,
    })
    return True


def _upsert_exercise_habit(db, habit_service, label: str | None, day: _date) -> None:
    hits = habit_service.find_by_name_fuzzy(db, "exercise")
    if not hits:
        habit = habit_service.create(db, name="exercise", polarity="positive")
    elif len(hits) == 1:
        habit = hits[0]
    else:
        habit = habit_service.find_by_name(db, "exercise") or hits[0]
    habit_service.upsert_entry(db, habit.id, day, True, note=label)


def _estimate_macros(food: str) -> list[dict] | None:
    """One small LLM call → [{calories}, {protein}]. None on failure (the
    food log just won't produce rows — never raises)."""
    food = (food or "").strip()
    if not food:
        return None
    from ...llm.client import llm_client
    from ..memory_extraction.prompts import _MACRO_ESTIMATE_PROMPT
    from ..memory_extraction.parsers import _parse_json_object

    try:
        raw = llm_client.generate_simple_completion(
            _MACRO_ESTIMATE_PROMPT.format(food=food[:400]),
            max_tokens=60,
            temperature=0.0,
            model="gpt-5.4-mini",
        )
    except Exception as e:
        print(f"[fitness handler] macro estimate LLM error: {e}")
        return None
    parsed = _parse_json_object(raw)
    if not parsed:
        return None
    out: list[dict] = []
    try:
        cals = parsed.get("calories")
        prot = parsed.get("protein_g")
        if cals is not None:
            out.append({"metric_type": "calories", "value": float(cals), "unit": "kcal"})
        if prot is not None:
            out.append({"metric_type": "protein", "value": float(prot), "unit": "g"})
    except (TypeError, ValueError):
        return None
    return out or None
