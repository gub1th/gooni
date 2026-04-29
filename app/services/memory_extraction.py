"""LLM-driven extraction + reconciliation for memories, tone corrections,
and feature requests.

Single unified extractor (`extract_signals`) emits all three signal types in
one LLM call so the orchestrator and note-save path don't run overlapping
classifiers per turn.

Pipeline:
1. extract_signals(text, prev_assistant?) → {tone_corrections, feature_requests, memories}
2. for each memory candidate:
     cosine-search similar active memories of the same type
     reconcile_candidate (LLM) — decide ADD / UPDATE / DELETE / NONE
     apply the decision

Reconcile is what makes memory self-clean. Without it, contradictory facts
pile up forever and confidence numbers stop meaning anything.
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
    Empty list on parse failure or no signal — never raises.

    Kept for backwards compatibility; prefer `extract_signals` which also
    surfaces tone corrections and feature requests in the same call.
    """
    if not user_message or not user_message.strip():
        return []
    prompt = _EXTRACTION_PROMPT.format(
        user=user_message[:1500],
        assistant=(assistant_reply or "")[:1500],
    )
    raw = llm_client.generate_simple_completion(prompt, max_tokens=600)
    parsed = _parse_json_array(raw)
    return [c for c in parsed if _validate_candidate(c)]


_SIGNALS_PROMPT = """Analyze the TEXT below and emit ALL signals it carries. Single JSON object.

PRIOR ASSISTANT REPLY (may be empty when text is a standalone note save):
\"\"\"{prev_assistant}\"\"\"

TEXT (Daniel just sent / saved):
\"\"\"{text}\"\"\"

Return JSON shaped exactly like this — no preamble, no markdown fence:
{{
  "tone_corrections": [
    {{"rule": "<short imperative rule, max 15 words>"}}
  ],
  "feature_requests": [
    {{
      "title": "<short imperative title, max 10 words>",
      "why":   "<one sentence describing what's missing today>"
    }}
  ],
  "memories": [
    {{
      "type": "preference" | "goal" | "fact" | "routine" | "constraint" | "episode",
      "key":  "snake_case_key" | null,
      "content": "natural-language description of the memory",
      "context": {{"time": null|str, "location": null|str, "scope": "global"|"contextual"}},
      "confidence": 0.0-1.0
    }}
  ],
  "worth_expanding": true | false
}}

Rules per field:

tone_corrections:
- Critique of the prior assistant reply's tone, style, length, structure, or approach.
- Examples: "too eager", "stop ending with questions", "less teacher-y", "no bullets".
- Empty when no prior assistant reply or no critique signal.

feature_requests:
- Daniel describes a Gooni capability that doesn't exist or is broken.
- Includes: hallucination call-outs ("you can't actually do that"), missing tools
  ("you don't have a scheduler"), feature asks ("you need to allow hyperlinks"),
  capability gaps phrased as commands or wishes.
- Title is imperative, terse. Why is one sentence describing the gap.
- Empty when text isn't asking for or critiquing a Gooni capability.

memories:
- Persistent facts about Daniel — same shape as before.
- "preference" = stable like/dislike. "goal" = aspiration. "fact" = declarative truth.
  "routine" = recurring habit. "constraint" = hard limit. "episode" = notable moment.
- key is snake_case for typed memories; null for episodes.
- scope: "global" = always applies; "contextual" = situation-specific.
- confidence: 0.85+ for explicit; 0.6-0.7 for inferences.
- Skip temporary states or one-off remarks.
- Empty when text is just a question, a thought, or a feature request with nothing
  declarative about Daniel.

worth_expanding (bool):
- TRUE if the text names a topic, idea, concept, project, or open question that
  Daniel would benefit from thinking through with a planning partner.
- TRUE for short topic-noun phrases that imply work to do: "cursor for content
  creators", "ambient device for the kitchen", "why is auth eating my afternoon".
- FALSE for journals ("lunch was good"), completed tasks ("taxes done"),
  one-off facts ("meeting at 3pm"), feedback for Gooni, pure emotional venting,
  or memories already covered by the memories array.
- When unsure, lean FALSE — false positives waste Daniel's attention.

If no signals across all fields, return all-empty arrays and worth_expanding=false.

JSON:"""


def _normalize_tone(items: Any) -> list[dict]:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        rule = it.get("rule")
        if isinstance(rule, str) and rule.strip():
            out.append({"rule": rule.strip()})
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


def extract_signals(text: str, prev_assistant: str | None = None) -> dict[str, Any]:
    """Single LLM call that emits all signal types from one input.

    Returns:
      {
        "tone_corrections": [{"rule": str}],
        "feature_requests": [{"title": str, "why": str}],
        "memories":         [memory candidate dicts],
        "worth_expanding":  bool,
      }

    All-empty / False on parse failure or no signal — never raises.
    Pass prev_assistant when this text is a chat reply (helps tone detection);
    leave None for note saves (tone usually empty for those).
    """
    empty = {
        "tone_corrections": [],
        "feature_requests": [],
        "memories": [],
        "worth_expanding": False,
    }
    if not text or not text.strip():
        return empty
    prompt = _SIGNALS_PROMPT.format(
        prev_assistant=(prev_assistant or "")[:1200],
        text=text[:2000],
    )
    try:
        raw = llm_client.generate_simple_completion(prompt, max_tokens=700)
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
    return {
        "tone_corrections": _normalize_tone(parsed.get("tone_corrections")),
        "feature_requests": _normalize_features(parsed.get("feature_requests")),
        "memories":         _normalize_memories(parsed.get("memories")),
        "worth_expanding":  bool(parsed.get("worth_expanding")),
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
