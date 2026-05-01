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


# Words/phrases that are strong hints of corrective intent. Pre-filter before
# the LLM call so most chat turns skip the API hit entirely.
_FEEDBACK_MARKERS = re.compile(
    r"\b("
    r"too|less|more|stop|don'?t|do not|dont|never|always|"
    r"sound|tone|shorter|longer|brief|"
    r"eager|teacher|formal|casual|"
    r"weird|wrong|annoying|cringe|robotic|stiff|"
    r"undo|forget that|disregard|"
    r"why are you|why did you|why do you"
    r")\b",
    re.IGNORECASE,
)


_DETECT_PROMPT = """Decide if the USER message is feedback/correction on the prior ASSISTANT reply.

PRIOR ASSISTANT REPLY:
\"\"\"{prev_assistant}\"\"\"

USER MESSAGE:
\"\"\"{current_user}\"\"\"

Feedback = critique of the reply's tone, style, length, content, structure, or approach.
  Examples: "too eager", "stop ending with questions", "be shorter", "less teacher-y",
  "don't open with affirmations", "that was robotic"

NOT feedback = a new question, a new topic, agreement, or info Daniel is sharing.
  Examples: "what about kickball?", "actually it's 95 calories", "ok thanks", "yes"

If feedback, also decide whether the message ALSO contains a new question that needs answering.

Reply ONLY with JSON. No preamble, no fence:
{{"is_feedback": <bool>, "rule": "<short imperative rule, max 15 words>" | null, "also_new_question": <bool>}}

Examples:
- "too eager" → {{"is_feedback": true, "rule": "don't open with eager affirmations", "also_new_question": false}}
- "stop ending with offers for more" → {{"is_feedback": true, "rule": "don't end replies with offers for more info", "also_new_question": false}}
- "less teacher-y. also what's a fair kick?" → {{"is_feedback": true, "rule": "don't sound like a teacher", "also_new_question": true}}
- "what about kickball rules?" → {{"is_feedback": false, "rule": null, "also_new_question": false}}

JSON:"""


# If user message is short and contains no marker, classify as NOT feedback
# without an LLM call. Tunable.
_MIN_WORDS_NO_MARKER = 4


class FeedbackDetector:
    def classify(self, prev_assistant: str, current_user: str) -> dict:
        """Returns {'is_feedback': bool, 'rule': str | None, 'also_new_question': bool}.

        Cheap pre-filter then LLM fallback. Never raises — on error returns
        a safe negative classification.
        """
        safe_negative = {
            "is_feedback": False,
            "rule": None,
            "also_new_question": False,
        }
        if not prev_assistant or not current_user:
            return safe_negative
        text = current_user.strip()
        if not text:
            return safe_negative
        word_count = len(text.split())
        has_marker = bool(_FEEDBACK_MARKERS.search(text))
        # Short messages with no marker are almost never feedback ("ok", "yes",
        # "got it"). Skip the API call.
        if not has_marker and word_count < _MIN_WORDS_NO_MARKER:
            return safe_negative
        # Long messages without any marker are usually new questions/topics,
        # but to keep the false-negative rate low we still query the LLM when
        # the message starts with hedging phrases.
        if not has_marker and word_count >= _MIN_WORDS_NO_MARKER:
            return safe_negative

        prompt = _DETECT_PROMPT.format(
            prev_assistant=(prev_assistant or "")[:1200],
            current_user=text[:600],
        )
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=120)
        except Exception as e:
            print(f"feedback_detector LLM error: {e}")
            return safe_negative
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
            return safe_negative
        if not isinstance(parsed, dict):
            return safe_negative
        is_feedback = bool(parsed.get("is_feedback"))
        rule = parsed.get("rule")
        if is_feedback and (not rule or not isinstance(rule, str)):
            # Detector said yes but didn't give a rule — treat as inconclusive.
            return safe_negative
        return {
            "is_feedback": is_feedback,
            "rule": rule.strip() if isinstance(rule, str) else None,
            "also_new_question": bool(parsed.get("also_new_question")),
        }


feedback_detector = FeedbackDetector()
