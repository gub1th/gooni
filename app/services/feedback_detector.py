"""Detects whether a user message is feedback on the prior assistant reply.

Used by the orchestrator to short-circuit normal reply generation and route
the message into the memory pipeline as a tone preference.

The detector is deliberately conservative: a regex pre-filter handles the
common cases for free, and the LLM call only fires when feedback markers
are present. When in doubt, returns is_feedback=False — false positives
disrupt chat more than missed feedback (Daniel can repeat himself).
"""

import json
import re

from ..llm.client import llm_client


# Words/phrases that are strong hints of corrective intent OR capability-gap
# accusations. Pre-filter before the LLM call so most chat turns skip the API
# hit entirely. Casts wider than tone-only since it now also gates capability
# detection ("you can't actually do that", "you don't even have...").
_FEEDBACK_MARKERS = re.compile(
    r"\b("
    r"too|less|more|stop|don'?t|do not|dont|never|always|"
    r"sound|tone|shorter|longer|brief|"
    r"eager|teacher|formal|casual|"
    r"weird|wrong|annoying|cringe|robotic|stiff|"
    r"undo|forget that|disregard|"
    r"why are you|why did you|why do you|"
    r"can'?t|cannot|hallucinat|made up|fake|"
    r"you don'?t (have|actually)|you'?re not able"
    r")\b",
    re.IGNORECASE,
)


_DETECT_PROMPT = """Classify the USER message into one of three kinds based on the prior ASSISTANT reply.

PRIOR ASSISTANT REPLY:
\"\"\"{prev_assistant}\"\"\"

USER MESSAGE:
\"\"\"{current_user}\"\"\"

Three kinds:

1. "tone" = critique of the reply's tone, style, length, structure, or approach.
   Examples: "too eager", "stop ending with questions", "be shorter", "less teacher-y",
   "don't open with affirmations", "that was robotic", "no bullets".

2. "capability_gap" = Daniel is calling out that Gooni hallucinated, faked, promised
   something it can't do, or claimed a capability it doesn't have. The fix is to BUILD
   that capability — not just change tone. Implies a missing feature.
   Examples: "you can't actually do that, can you?", "you don't have a scheduler",
   "you made that up", "stop pretending you can send reminders", "you should be able
   to filter notes by date but you can't".

3. "none" = a new question, a new topic, agreement, info Daniel is sharing.
   Examples: "what about kickball?", "actually it's 95 calories", "ok thanks", "yes".

If kind is tone OR capability_gap, also decide whether the message ALSO contains a
new question that needs answering.

Reply ONLY with JSON. No preamble, no fence:
{{
  "kind": "tone" | "capability_gap" | "none",
  "rule": "<short imperative rule, max 15 words>" | null,
  "feature_title": "<short imperative title, max 10 words>" | null,
  "feature_why": "<one-sentence explanation of what's missing>" | null,
  "also_new_question": <bool>
}}

Use rule only for kind=tone. Use feature_title + feature_why only for kind=capability_gap.

Examples:
- "too eager" → {{"kind":"tone","rule":"don't open with eager affirmations","feature_title":null,"feature_why":null,"also_new_question":false}}
- "you can't actually remind me at 6pm" → {{"kind":"capability_gap","rule":null,"feature_title":"outbound time-based reminders","feature_why":"Daniel asked for a 6pm reminder; Gooni has no scheduler or proactive Telegram messaging.","also_new_question":false}}
- "what about kickball rules?" → {{"kind":"none","rule":null,"feature_title":null,"feature_why":null,"also_new_question":false}}

JSON:"""


# If user message is short and contains no marker, classify as NOT feedback
# without an LLM call. Tunable.
_MIN_WORDS_NO_MARKER = 4


class FeedbackDetector:
    def classify(self, prev_assistant: str, current_user: str) -> dict:
        """Three-way classify:
          {'kind': 'tone' | 'capability_gap' | 'none',
           'rule': str | None,
           'feature_title': str | None,
           'feature_why': str | None,
           'also_new_question': bool,
           'is_feedback': bool}

        is_feedback is a derived convenience flag (True when kind != 'none').
        Cheap pre-filter then LLM fallback. Never raises — on error returns
        a safe-none classification.
        """
        safe_none = {
            "kind": "none",
            "rule": None,
            "feature_title": None,
            "feature_why": None,
            "also_new_question": False,
            "is_feedback": False,
        }
        if not prev_assistant or not current_user:
            return safe_none
        text = current_user.strip()
        if not text:
            return safe_none
        word_count = len(text.split())
        has_marker = bool(_FEEDBACK_MARKERS.search(text))
        # Short messages with no marker are almost never feedback ("ok", "yes",
        # "got it"). Skip the API call.
        if not has_marker and word_count < _MIN_WORDS_NO_MARKER:
            return safe_none
        # Longer messages still skip the LLM unless a marker is present —
        # keeps the API spend bounded on chatty turns.
        if not has_marker:
            return safe_none

        prompt = _DETECT_PROMPT.format(
            prev_assistant=(prev_assistant or "")[:1200],
            current_user=text[:600],
        )
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=200)
        except Exception as e:
            print(f"feedback_detector LLM error: {e}")
            return safe_none
        cleaned = (raw or "").strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1].strip()
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as e:
            print(f"feedback_detector JSON parse error: {e} | raw: {cleaned[:200]}")
            return safe_none
        if not isinstance(parsed, dict):
            return safe_none
        kind = parsed.get("kind")
        if kind not in ("tone", "capability_gap", "none"):
            return safe_none

        rule = parsed.get("rule")
        rule = rule.strip() if isinstance(rule, str) else None
        feature_title = parsed.get("feature_title")
        feature_title = feature_title.strip() if isinstance(feature_title, str) else None
        feature_why = parsed.get("feature_why")
        feature_why = feature_why.strip() if isinstance(feature_why, str) else None

        # Inconclusive guards — if the model said tone/capability_gap but
        # didn't fill the relevant payload, treat as none.
        if kind == "tone" and not rule:
            return safe_none
        if kind == "capability_gap" and not feature_title:
            return safe_none

        return {
            "kind": kind,
            "rule": rule,
            "feature_title": feature_title,
            "feature_why": feature_why,
            "also_new_question": bool(parsed.get("also_new_question")),
            "is_feedback": kind != "none",
        }


feedback_detector = FeedbackDetector()
