"""LLM-driven memory extraction + reconciliation.

Two-step pipeline mirroring Mem0's architecture:
1. Extract candidate memories from a chat exchange (single LLM call)
2. Reconcile each candidate against semantically-similar existing memories
   and decide ADD / UPDATE / DELETE / NONE per candidate (single LLM call)

The reconcile step is what makes memory self-clean. Without it, contradictory
facts pile up forever and confidence numbers stop meaning anything.
"""

import json
from typing import Any

from ..llm.client import llm_client


VALID_TYPES = {"preference", "goal", "fact", "routine", "constraint", "episode"}


_EXTRACTION_PROMPT = """Extract structured user-profile updates from this chat exchange.

User message: {user}
Gooni reply:  {assistant}

Return ONLY a JSON array. No preamble, no markdown fence.

Schema per item:
{{
  "type": "preference" | "goal" | "fact" | "routine" | "constraint" | "episode",
  "key": "snake_case_key" | null,
  "content": "natural-language description of the memory",
  "context": {{"time": null|str, "location": null|str, "scope": "global"|"contextual"}},
  "confidence": 0.0-1.0
}}

Rules:
- Only extract PERSISTENT info — not temporary states or one-off remarks
- "preference" = stable likes/dislikes (e.g. "prefers dark mode IDE")
- "goal" = aspiration, has a desired outcome
- "fact" = declarative truth about Daniel
- "routine" = recurring habit/pattern
- "constraint" = hard limit (allergies, schedule blockers, dealbreakers)
- "episode" = a notable moment from the chat itself (no key, just content)
- key is snake_case (e.g. "ide_theme_preference"); null for episodes
- scope: "global" = always applies; "contextual" = situation-specific
- confidence: 0.85+ for explicit statements; 0.6-0.7 for inferences
- Return [] if nothing extractable

Examples:
- "I prefer hot coffee" → preference, coffee_temperature, hot, global, 0.9
- "I work from home Tuesdays" → routine, tuesday_location, home, contextual, 0.85
- "Just shipped Gooni v2!" → episode, null, "shipped Gooni v2", global, 0.9

JSON array:"""


_RECONCILE_PROMPT = """Decide what to do with this CANDIDATE memory given EXISTING similar memories.

CANDIDATE:
  type: {ctype}
  key: {ckey}
  content: {ccontent}
  confidence: {cconfidence}

EXISTING similar memories (id | type | key | content | confidence):
{existing}

Pick exactly one action:
- "ADD" if this is genuinely new info not covered above
- "UPDATE" with target_id if this refines or replaces an existing memory (the
  existing memory will be marked inactive, this becomes the new active version)
- "DELETE" with target_id if this CONTRADICTS an existing memory (e.g.
  "I switched to light mode" when there's an existing "prefers dark mode" —
  delete the old one and ADD the new one separately; you can return DELETE
  here and the caller will run a follow-up ADD)
- "NONE" if this is already known (just bump confidence on the matched id)

Return ONLY a JSON object. No preamble, no fence:
{{"action": "ADD" | "UPDATE" | "DELETE" | "NONE", "target_id": int | null, "reason": "short why"}}

Examples:
- candidate "prefers dark IDE", existing has same → {{"action":"NONE","target_id":2,"reason":"already known"}}
- candidate "switched to light mode", existing has "prefers dark mode" id=2 → {{"action":"UPDATE","target_id":2,"reason":"preference flipped"}}
- candidate "allergic to peanuts", existing empty → {{"action":"ADD","target_id":null,"reason":"new constraint"}}

JSON:"""


def _parse_json_array(raw: str) -> list:
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1].strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"memory extraction JSON parse error: {e} | raw: {cleaned[:200]}")
        return []
    return parsed if isinstance(parsed, list) else []


def _parse_json_object(raw: str) -> dict | None:
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1].strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"memory reconcile JSON parse error: {e} | raw: {cleaned[:200]}")
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate_candidate(c: dict) -> bool:
    if not isinstance(c, dict):
        return False
    if c.get("type") not in VALID_TYPES:
        return False
    if not c.get("content") or not isinstance(c["content"], str):
        return False
    conf = c.get("confidence")
    if not isinstance(conf, (int, float)) or not (0.0 <= conf <= 1.0):
        return False
    ctx = c.get("context") or {}
    if not isinstance(ctx, dict):
        return False
    if ctx.get("scope") not in ("global", "contextual"):
        return False
    return True


def extract_candidates(user_message: str, assistant_reply: str) -> list[dict[str, Any]]:
    """Run the extraction LLM call. Returns validated list of candidate dicts.
    Empty list on parse failure or no signal — never raises."""
    if not user_message or not user_message.strip():
        return []
    prompt = _EXTRACTION_PROMPT.format(
        user=user_message[:1500],
        assistant=(assistant_reply or "")[:1500],
    )
    raw = llm_client.generate_simple_completion(prompt, max_tokens=600)
    parsed = _parse_json_array(raw)
    return [c for c in parsed if _validate_candidate(c)]


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
    raw = llm_client.generate_simple_completion(prompt, max_tokens=120)
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
