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
- "preference" = stable likes/dislikes (e.g. "prefers dark mode IDE").
  HIGH BAR: only use this when Daniel is explicitly stating a stable
  taste / style rule. Do NOT use it for chat transcripts, todo lists,
  in-progress thoughts, or summaries of what the assistant just said.
- "goal" = aspiration, has a desired outcome
- "fact" = declarative truth about Daniel
- "routine" = recurring habit/pattern
- "constraint" = hard limit (allergies, schedule blockers, dealbreakers)
- "episode" = a notable moment from the chat itself (no key, just content)
- key is snake_case (e.g. "ide_theme_preference"); null for episodes
- scope: "global" = always applies; "contextual" = situation-specific
- confidence: 0.85+ for explicit statements; 0.6-0.7 for inferences
- Return [] if nothing extractable

Anti-examples — DO NOT extract these as preferences:
- A chat transcript snippet recapping the assistant's reply ("The user
  inquired about X, the assistant said Y…") — that's an episode at best,
  often nothing. Never a preference.
- A todo list / planning bullet ("Finish resume / Email George / Buy X").
  Never a preference. Skip entirely or treat as episode if notable.
- The assistant restating its own behavior ("I will adjust as needed"). Skip.
- "User wants Gooni to handle Markdown formatting" when this is just the
  assistant agreeing to a one-off ask — preference only if Daniel asserts
  a stable style.

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
- "NONE" if this is already known (just bump confidence on the matched id).
  PARAPHRASES ALWAYS COUNT AS NONE: if the candidate restates an existing
  rule with different words but the same meaning, return NONE. Be greedy
  about this — duplication compounds and bloats the system prompt.

Return ONLY a JSON object. No preamble, no fence:
{{"action": "ADD" | "UPDATE" | "DELETE" | "NONE", "target_id": int | null, "reason": "short why"}}

Examples:
- candidate "prefers dark IDE", existing has same → {{"action":"NONE","target_id":2,"reason":"already known"}}
- candidate "wants concise responses", existing "User prefers concise responses" id=7 → {{"action":"NONE","target_id":7,"reason":"paraphrase of same rule"}}
- candidate "less directive", existing "avoid being too directive or harsh" id=12 → {{"action":"NONE","target_id":12,"reason":"narrower paraphrase, same intent"}}
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
    {{
      "rule": "<short imperative rule, max 18 words, anchored on the SPECIFIC pattern Daniel objected to>",
      "evidence": "<short verbatim phrase or behavior in the prior assistant reply that triggered Daniel — max 12 words>",
      "anti_pattern": "<concrete example of the kind of phrasing future-Gooni must AVOID — max 18 words. Empty string if not applicable>"
    }}
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
- SPEAKER DIRECTION (read carefully): Daniel must be EXPLICITLY instructing
  future-Gooni to change its behavior. Casual swearing, trash talk, or rude
  language aimed AT Gooni is NOT a tone correction on its own. The signal is
  venting, not feedback. Require an explicit instruction phrase: "don't say
  X", "stop being X", "stop doing X", "I want you to X", "you should X",
  "be more X", "be less X". When in doubt, emit []. False positives here
  pollute the preference store and steer every future reply wrong.
- BE SPECIFIC. Bland abstractions like "be more concise" are useless — capture
  the actual offense. If Daniel says "stop saying 'great question'", the rule
  is `no flattery openers like "great question"`, NOT `more concise`.
- `evidence` is mandatory: quote the specific phrase or pattern in the
  PRIOR ASSISTANT REPLY that triggered the correction. If you can't point at
  a specific phrase, the correction is too vague — emit an empty array.
- `anti_pattern` is a concrete phrasing future-Gooni must recognize and
  avoid. It MUST be grounded in `evidence` + `rule` — a phrasing Daniel
  would actually recognize as the offending pattern. Never invent
  unrelated example phrases. Leave as "" when nothing grounded fits.
- Examples (good):
    rule: "no flattery openers like 'great question' or 'of course'"
    evidence: "Sure! Great question." anti_pattern: "Great question! Let's…"
    --
    rule: "stop ending replies with a follow-up question Daniel didn't ask for"
    evidence: "What else are you thinking about?" anti_pattern: "Let me know if you'd like to dive deeper."
    --
    rule: "drop the 'I'd be happy to help' / 'I'd love to' filler"
    evidence: "I'd be happy to help with that!" anti_pattern: "Happy to dive in!"
- Examples (BAD — do NOT emit these):
    Vague rules: "less directive", "be more concise", "User prefers
    concise responses", "avoid being too directive or harsh" — these
    don't teach future-Gooni anything specific. If you'd write one of
    these, you're under-extracting; look harder at the prior reply for
    the actual offense.
    Speaker-flip false positives:
      Text "i am doing it dumbass" → emit [], NOT a rule like "avoid
      condescending language like 'dumbass'". Daniel is venting AT
      Gooni, not directing Gooni's tone. No instruction phrase = no rule.
      Text "you're being dumb" or "ur retarded" → emit [] unless followed
      by an explicit instruction.
    Hallucinated anti_patterns: never emit a rule whose anti_pattern
    references a phrase that doesn't appear in the prior reply or doesn't
    directly mirror the rule. Empty string is the correct fallback.
- Empty when no prior assistant reply or no critique signal.

feature_requests:

  *** HARD GATE — APPLY FIRST, BEFORE ANY OTHER REASONING ***
  If the text is interrogative — ends with "?", or starts with one of:
    can, could, do, does, did, are, is, will, would, should, may,
    might, what, how, when, where, why, who
  — emit [] for feature_requests. NO EXCEPTIONS. Questions are NEVER
  feature_requests. Even if the question concerns a missing capability,
  the user is ASKING about it, not REQUESTING it. The reply step will
  answer the question; this field stays empty.

  Examples that hit the hard gate (all → []):
    "Can I log focuses?"
    "Can you add calendar integration?"
    "Could you set a timer for me?"
    "Do you have the ability to log focused?"
    "Do you support markdown?"
    "Are you able to add to my calendar?"
    "Is there a way to log focuses?"
    "Will you ever support hyperlinks?"
    "What can you do?"
    "How do I add a calendar event?"

  ONLY exception: same-message follow-up imperative AFTER the question
  ("Can you X? Just add it." → fires on "Just add it"). The imperative
  must be a separate sentence; trailing politeness ("please?", "would
  that work?") doesn't qualify.

- After the hard gate passes (text is NOT a question):
- INCLUDE feature_requests when Daniel uses imperative or wish form:
    "add X", "you need X", "I want you to be able to X", "X should work",
    "you should be able to X", hallucination call-outs ("you can't actually
    do that — log it as a feature"), explicit missing-tool statements
    ("you don't have a scheduler"), bug critiques.
- Title is imperative, terse. Why is one sentence describing the gap.
- Imperative examples (NO question mark, → fires):
    "Add calendar integration"          → [{{title:"Add calendar integration", ...}}]
    "you need to allow hyperlinks"      → [{{title:"Allow hyperlinks", ...}}]
    "you should be able to set timers"  → [{{title:"Set timers", ...}}]
    "you don't have a scheduler"        → [{{title:"Add scheduler", ...}}]
- Empty when text is a question, or isn't asserting a missing capability.

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
        raw = llm_client.generate_simple_completion(prompt, max_tokens=700, temperature=0.0)
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
    raw = llm_client.generate_simple_completion(prompt, max_tokens=120, temperature=0.0)
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
