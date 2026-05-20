"""Voice-of-reason push-back for newly-created Promises.

Daniel said: Gooni should evaluate whether a promise is dumb, and push
back with a suggested reshape — never silently refuse, never block the
creation. The promise still lands; the evaluator just attaches a
critique that the ack helper surfaces and that the orchestrator's
[just extracted] block exposes to the LLM.

Four checks, ordered by signal strength:

  1. COUPLED REWARD — "if I X then I can Y" pattern where Y is a
     reward and X is the effort. Brittle by design (one slip kills
     both promise + reward). Regex over conditional + reward verbs.

  2. CONFLICTS ACTIVE — cosine-match the utterance against active
     pending promises. If ≥ 0.85 → already committed to ~the same
     thing; suggest restarting the existing clock instead of
     spawning a duplicate contract.

  3. TOO VAGUE — utterance lacks a concrete verb or measurable
     anchor ("be better about sleep"). No anchor = no possible
     judgment at term, so the promise can never be "kept" in a
     meaningful way.

  4. TRACK-RECORD DOUBT — slip_count ≥ 3 on the new Promise (i.e.
     Daniel has uttered + broken similar promises three or more
     times before). Suggest the asking what's different this round.

All checks deterministic — pure regex + numeric. No LLM. Suggestions
are template strings; we trade clever per-flag wording for zero LLM
cost on every promise create. Higher-end Voice work (LLM-shaped
reshapes) can layer on top in a follow-up — for now the priority is
that Daniel ALWAYS hears Gooni's take when one applies.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session


# ── Pattern checks ────────────────────────────────────────────────────

_COUPLED_REWARD_RE = re.compile(
    r"\b(if|when|after|once)\b.{1,80}?\b("
    # "then i'll <anything>" — explicit conditional reward clause.
    r"then\s+i('?ll|\s+can|\s+get\s+to|\s+can\s+have|'?ll\s+let\s+myself)|"
    # "i can/get to/have/deserve <reward verb>" — implicit reward clause
    # without "then" since casual speech often drops it.
    r"i('?ll|\s+can|\s+get\s+to|\s+can\s+have|\s+have|\s+deserve|\s+earn|\s+get)\s+("
    r"drink|smoke|relax|reward|treat|eat|chill|skip|have|a\s+beer|"
    r"a\s+drink|a\s+cheat|cake|dessert|cheat\s+day|day\s+off"
    r")"
    r")\b",
    re.IGNORECASE,
)

# Strong concrete-verb anchor list — having any of these in the
# utterance signals the promise is actionable enough to judge at term.
# Absence of all of them + low word count → flag as vague.
_CONCRETE_VERBS_RE = re.compile(
    r"\b("
    r"call|text|email|ship|finish|build|write|read|run|jog|walk|hike|"
    r"lift|stretch|cook|clean|study|review|fix|deploy|publish|post|"
    r"send|pay|cancel|delete|unsubscribe|book|schedule|attend|join|"
    r"leetcode|gym|workout|meditate|journal|sleep\s+by|wake|practice|"
    r"submit|apply|interview|prep|polish|launch|recover|stretch"
    r")\b",
    re.IGNORECASE,
)

# Numeric / temporal anchor — a number, count, or time-window phrase.
# A promise without a verb AND without an anchor is too vague to judge.
_ANCHOR_RE = re.compile(
    r"\b("
    r"\d+|"
    r"daily|weekly|monthly|tonight|tomorrow|today|"
    r"by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"the\s+\w+|next\s+\w+)"
    r")\b",
    re.IGNORECASE,
)

# Conflict similarity threshold — same near-duplicate bar promise_service
# uses for its own dedup, but here we only FLAG (we don't dedup; that's
# already done elsewhere). The flag fires when the existing pending
# promise wasn't quite close enough for dedup but still feels redundant.
_CONFLICT_THRESHOLD = 0.85

# Track-record doubt threshold — number of past broken promises matching
# this utterance pattern (≥ 0.80 cosine, computed in promise_service via
# `_count_prior_slips`). Three strikes earns a flag.
_TRACK_RECORD_FLOOR = 3


def _check_coupled_reward(text: str) -> bool:
    return bool(text and _COUPLED_REWARD_RE.search(text))


def _check_too_vague(text: str) -> bool:
    if not text:
        return True
    # Concrete verb or anchor wins regardless of length — short atomic
    # utterances ("call mom tomorrow", "leetcode daily") are NOT vague.
    if _CONCRETE_VERBS_RE.search(text):
        return False
    if _ANCHOR_RE.search(text):
        return False
    # No verb AND no anchor → can't be judged at term → vague.
    return True


def _check_conflicts_active(db: Session, vec: list[float] | None) -> dict[str, Any] | None:
    """Return {'id', 'summary', 'score'} of the best conflicting active
    pending promise, or None. Skip silently when no vector available."""
    if not vec:
        return None
    from ..db.models import Promise
    from .promise_service import _cos  # type: ignore[attr-defined]

    # Some installs may not export `_cos`; fall back to local cosine.
    try:
        cos_fn = _cos
    except NameError:
        cos_fn = _cosine

    import json
    rows = (
        db.query(Promise.id, Promise.embedding, Promise.summary, Promise.utterance)
        .filter(Promise.state == "active", Promise.embedding.is_not(None))
        .all()
    )
    best: tuple[int, float, str] | None = None
    for pid, emb_json, summ, utter in rows:
        try:
            emb = json.loads(emb_json)
        except Exception:
            continue
        score = cos_fn(vec, emb)
        if score >= _CONFLICT_THRESHOLD and (best is None or score > best[1]):
            best = (pid, score, summ or utter or "")
    if best is None:
        return None
    return {"id": best[0], "summary": best[2], "score": best[1]}


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    import math
    dot = sum(x * y for x, y in zip(a, b))
    ma = math.sqrt(sum(x * x for x in a))
    mb = math.sqrt(sum(y * y for y in b))
    if ma == 0 or mb == 0:
        return 0.0
    return dot / (ma * mb)


# ── Public API ────────────────────────────────────────────────────────


def evaluate(
    db: Session,
    *,
    utterance: str,
    summary: str | None,
    slip_count: int,
    vec: list[float] | None,
) -> dict[str, Any] | None:
    """Run all four checks. Return the evaluation payload — or None when
    nothing fires (silent pass-through). Caller surfaces the payload via
    the ack helper + the [just extracted] block.

    Payload shape:
      {
        "flags": ["coupled_reward", ...],   # all matched, ordered
        "primary": "coupled_reward",        # the loudest flag (rendered)
        "suggestion": "<one-line tweak>",   # template per primary
        "details": {                        # context for the flag
          "conflict_id": int | None,
          "conflict_summary": str | None,
          "slip_count": int,
        }
      }
    """
    text = (utterance or summary or "").strip()
    flags: list[str] = []
    details: dict[str, Any] = {
        "conflict_id": None,
        "conflict_summary": None,
        "slip_count": slip_count,
    }

    if _check_coupled_reward(text):
        flags.append("coupled_reward")

    conflict = _check_conflicts_active(db, vec)
    if conflict is not None:
        flags.append("conflicts_active")
        details["conflict_id"] = conflict["id"]
        details["conflict_summary"] = conflict["summary"]

    if _check_too_vague(text):
        flags.append("too_vague")

    if slip_count >= _TRACK_RECORD_FLOOR:
        flags.append("track_record_doubt")

    if not flags:
        return None

    # Severity order: conflicts_active first (most actionable — there's
    # a concrete pre-existing row to point at), then track_record_doubt
    # (numeric + objective), then coupled_reward (structural), then
    # too_vague (least specific). Caller renders only the primary.
    severity = (
        "conflicts_active",
        "track_record_doubt",
        "coupled_reward",
        "too_vague",
    )
    primary = next((f for f in severity if f in flags), flags[0])

    suggestion = _suggestion_for(primary, details)

    return {
        "flags": flags,
        "primary": primary,
        "suggestion": suggestion,
        "details": details,
    }


def _suggestion_for(primary: str, details: dict[str, Any]) -> str:
    """Template per flag. Lowercase casual, Alfred-shaped.

    Kept template-driven (no LLM) so every flagged promise gets the same
    deterministic nudge. If/when richer per-context phrasing matters,
    swap in a single gpt-4o-mini call here gated on flag severity.
    """
    if primary == "conflicts_active":
        existing = details.get("conflict_summary") or "an existing one"
        # Trim long existing summaries so the nudge stays one line.
        if len(existing) > 60:
            existing = existing[:60].rstrip() + "…"
        return (
            f"this overlaps an existing pending promise — \"{existing}\". "
            f"restart the clock instead of spawning a duplicate?"
        )
    if primary == "track_record_doubt":
        n = details.get("slip_count") or 0
        return (
            f"you've broken something like this {n} time(s) before. "
            f"what's different this round?"
        )
    if primary == "coupled_reward":
        return (
            "this couples reward to effort — one slip nukes both. "
            "want to capture just the effort half?"
        )
    if primary == "too_vague":
        return (
            "no concrete verb or anchor. how would you know it's kept? "
            "add a target (date / count / 'no X for N days')."
        )
    return ""
