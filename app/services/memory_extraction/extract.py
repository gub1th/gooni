"""LLM orchestration for memory extraction + reconciliation.

Ties prompts + parsers + normalizers together. Public entry points:
extract_signals, reconcile_candidate.
"""

import json
import re
from datetime import date as _date
from typing import Any

from ...llm.client import llm_client
from .prompts import _RECONCILE_PROMPT, _SIGNALS_PROMPT
from .parsers import _parse_json_object
from .normalizers import (
    _normalize_features,
    _normalize_fitness,
    _normalize_memories,
    _normalize_promise_signals,
    _normalize_reply_intent,
    _normalize_tone,
)


# Regex pre-filter for extract_signals. If the text has NONE of these
# trigger phrases, we skip the LLM call entirely (returns empty) — most
# pure-capture notes ("groceries: milk eggs", "kitchen sink") carry no
# signal but still cost ~$0.0003/note today. Conservative trigger set:
# only phrases that overwhelmingly correlate with at least one signal
# type. False negatives (signal missed because phrasing didn't trip the
# regex) re-fire on the next save once the trigger landed in the text.
_PREFILTER_TRIGGERS = re.compile(
    r"\b("
    r"need to|needs to|want to|wanna|gotta|"
    r"should(?!\s+have)|must|have to|"
    r"imma|i'?ll|i am going to|i'?m going to|going to|"
    r"remind|reminder|"
    r"prefer|like better|hate|"
    r"feature|broken|bug|fix this|"
    r"track|log|"
    r"feedback|annoying|too\s+\w+|don'?t\s+\w+|"
    r"todo|to-?do|"
    r"add (a|to|that)|save (this|a)|"
    r"call|text|email|message|book|schedule|"
    # Fitness logging on note-save: chat surfaces bypass the prefilter
    # entirely (prev_assistant is set), so this only guards notes. Bare
    # weight ("175 this morning") may still slip through with no trigger
    # word — acceptable; chat is the primary logging surface.
    r"cal|cals|calorie|protein|kcal|macro|"
    r"gym|workout|lifted|ran|run|cardio|"
    r"ate|eating|breakfast|lunch|dinner|snack|meal|"
    r"weigh|\d+\s*g\b|\d+\s*lbs?\b|\d+\s*kg\b"
    r")\b",
    re.IGNORECASE,
)


# Hybrid day-total override (high-precision half). The gpt-5.4-mini extractor
# emits `correction_scope` for paraphrases, but the destructive "collapse the
# whole day" path shouldn't be left solely to a mini-model's judgment — the
# running-total explosion (logged 501g protein) came from exactly that
# misclassification. So these unambiguous whole-day restatements force
# correction_scope="day" deterministically, regardless of what the LLM said.
# Precision over recall: only the clearest shapes; the LLM widens coverage.
_DAY_TOTAL_OVERRIDE_RE = re.compile(
    # "change/set/make/update ... to 1,740 / 127" — Daniel's slash restatement
    r"\b(?:change|set|make|update)\b[^.\n]{0,15}\bto\s+\d[\d,]*\s*/\s*\d+"
    # "(daily) total should be / is / to 1740"
    r"|\b(?:daily\s+)?total\s+(?:should\s+be|is|to)\s+\d[\d,]+"
    # "you're at 1740"
    r"|\b(?:you'?re|your)\s+at\s+\d[\d,]+",
    re.IGNORECASE,
)


def extract_signals(
    text: str,
    prev_assistant: str | None = None,
    today: _date | None = None,
) -> dict[str, Any]:
    """Single LLM call that emits all signal types from one input.

    Returns:
      {
        "tone_corrections": [{"rule": str}],
        "feature_requests": [{"title": str, "why": str}],
        "promises":         [{"kind", "utterance", "cadence", ...}],
        "memories":         [memory candidate dicts],
      }

    All-empty on parse failure or no signal — never raises.
    Pass prev_assistant when this text is a chat reply (helps tone detection);
    leave None for note saves (tone usually empty for those).

    `today` is the user's local calendar date (callers pass
    common.local_today(db)); it anchors relative-date resolution
    ("weighed 70.8 yesterday") in the prompt AND the future-clamp on
    fitness log_dates. Falls back to date.today() when None — but that's
    server-UTC, so DB-backed callers should always pass it.

    Cost optimization (phase 4): regex pre-filter skips the LLM entirely
    when text contains no signal-trigger phrases. Pure-capture text
    ("groceries: milk eggs") returns empty without burning an API call.
    Chat surfaces bypass the prefilter when prev_assistant is set — tone
    corrections often phrased as "less of that" without trigger words.
    """
    empty = {
        "tone_corrections": [],
        "feature_requests": [],
        "promises": [],
        "fitness_logs": [],
        "reply_intent": "answer",
        "memories": [],
    }
    if not text or not text.strip():
        return empty

    # Prefilter on note saves only. Chat turns always run extraction —
    # tone corrections ("less of that", "be terser") often lack trigger
    # phrases but are critical to capture.
    if prev_assistant is None and not _PREFILTER_TRIGGERS.search(text):
        return empty

    today_d = today or _date.today()
    prompt = _SIGNALS_PROMPT.format(
        prev_assistant=(prev_assistant or "")[:1200],
        text=text[:2000],
        today=today_d.isoformat(),
    )
    try:
        # max_tokens is a CAP, not a spend — but at 500 a multi-signal burst
        # ("did gym, 2100 cal, close X, imma Y, also my brother moved")
        # truncated the JSON mid-array → parse fail → ALL signals silently
        # dropped (audit 2026-06-10). 1500 covers the 8-array schema.
        raw = llm_client.generate_simple_completion(prompt, max_tokens=1500, temperature=0.0, model="gpt-5.4-mini")
    except Exception as e:
        print(f"extract_signals LLM error: {e}")
        return empty
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1].strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"extract_signals JSON parse error: {e} | raw: {cleaned[:240]}")
        return empty
    if not isinstance(parsed, dict):
        return empty
    fitness = _normalize_fitness(parsed.get("fitness_logs"), today_d)
    # Hybrid override: a clear whole-day restatement in the raw text force-flags
    # the calorie/protein-bearing entries as day-scope corrections, so the
    # handler collapses (set_cell) instead of appending — even if the LLM read
    # it as an item fix or a fresh log.
    if fitness and _DAY_TOTAL_OVERRIDE_RE.search(text):
        for f in fitness:
            if f["log_type"] in ("food", "macros_explicit"):
                f["correction"] = True
                f["correction_scope"] = "day"
    return {
        "tone_corrections": _normalize_tone(parsed.get("tone_corrections")),
        "feature_requests": _normalize_features(parsed.get("feature_requests")),
        "promises":         _normalize_promise_signals(parsed.get("promises"), today_d),
        "fitness_logs":     fitness,
        "reply_intent":     _normalize_reply_intent(parsed.get("reply_intent")),
        "memories":         _normalize_memories(parsed.get("memories")),
    }


def reconcile_candidate(
    candidate: dict, existing_similar: list[dict]
) -> dict | None:
    """Run the reconcile LLM call. Returns dict with action/target_id/reason
    or None on parse failure. existing_similar items must have id/type/key/
    content/confidence keys."""
    if not existing_similar:
        # Nothing similar exists — caller can shortcut to ADD without an LLM call
        return {"action": "ADD", "target_id": None, "reason": "no similar existing"}

    existing_block = "\n".join(
        f"  {m['id']} | {m['type']} | {m.get('key') or '(none)'} | "
        f"{(m.get('content') or '')[:120]} | {m.get('confidence', 0):.2f}"
        for m in existing_similar
    )
    prompt = _RECONCILE_PROMPT.format(
        ctype=candidate.get("type"),
        ckey=candidate.get("key") or "(none)",
        ccontent=(candidate.get("content") or "")[:200],
        cconfidence=candidate.get("confidence", 0.8),
        existing=existing_block,
    )
    raw = llm_client.generate_simple_completion(prompt, max_tokens=120, temperature=0.0, model="gpt-5.4-mini")
    parsed = _parse_json_object(raw)
    if not parsed:
        return None
    action = parsed.get("action")
    if action not in ("ADD", "UPDATE", "DELETE", "NONE"):
        return None
    target = parsed.get("target_id")
    # Defense: ADD must have null target; UPDATE/DELETE/NONE must have an int target
    valid_ids = {m["id"] for m in existing_similar}
    if action == "ADD":
        target = None
    else:
        if not isinstance(target, int) or target not in valid_ids:
            return None
    return {
        "action": action,
        "target_id": target,
        "reason": parsed.get("reason", ""),
    }
