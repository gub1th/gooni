"""Promise complexity classifier.

A "simple" promise is atomic + bounded ("call mom tomorrow") — instant
lock, no game-plan ritual. A "complex" promise has a duration / recurrence
shape ("no weed for 7 days", "leetcode daily this week") and benefits
from a lock-in ritual that probes for start, end, and what counts as
breaking.

Implementation: regex over duration / recurrence signal words. Pure
function, no LLM, no embeddings. Cheap enough to call on every promise
creation. False negatives (complex utterance routed as simple) degrade
to current behavior — instant lock without probe. False positives
(simple utterance routed as complex) degrade to one extra confirmation
turn — annoying but not destructive.

Wire-up: `promise_service.create` calls `needs_game_plan(utterance)`
and logs the classification + stores it on the per-create trace. Lock-in
flow (PR-B) consumes the bool to choose between instant-create and
probe-then-create.
"""

from __future__ import annotations

import re

# Word-boundary regex sources. Combined into one compiled pattern so we
# do a single pass over the text. Each phrase here is a STRONG signal
# that the promise has a duration or recurrence shape:
#
#   - day / days / week / weeks / month / months / year  → explicit window
#   - daily / weekly / monthly                            → recurring cadence
#   - until                                                → open-ended deadline
#   - every <unit>                                         → recurrence
#   - for \d+                                              → counted window
#   - starting                                             → explicit anchor
#   - through / over the next                              → window markers
#
# Word boundaries (\b) prevent false fires on substrings ("today" doesn't
# match "day" because of \bday\b).
_COMPLEX_PATTERNS: tuple[str, ...] = (
    r"\bday(s)?\b",
    r"\bweek(s)?\b",
    r"\bmonth(s)?\b",
    r"\byear(s)?\b",
    r"\bdaily\b",
    r"\bweekly\b",
    r"\bmonthly\b",
    r"\buntil\b",
    r"\bevery\s+(day|week|month|morning|night|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    r"\bfor\s+\d+\b",
    r"\bstarting\b",
    r"\bthrough\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+|the\s+weekend|the\s+end\s+of)\b",
    r"\bover\s+the\s+next\b",
)

_COMPLEX_RE = re.compile("|".join(_COMPLEX_PATTERNS), re.IGNORECASE)


# Same-day / atomic hints — explicit anti-signals that bias toward simple
# even when a complex word appears. E.g. "call mom this weekend" has
# "weekend" but it's a one-shot atomic action, not a recurring or
# duration-bounded commitment. These take precedence ONLY when no
# duration counter (`for 3 days`, `every monday`) is present.
_SIMPLE_HINTS: tuple[str, ...] = (
    r"\btonight\b",
    r"\btomorrow\b",
    r"\btoday\b",
    r"\bthis\s+(morning|afternoon|evening|weekend)\b",
    r"\bin\s+the\s+(morning|afternoon|evening)\b",
)
_SIMPLE_RE = re.compile("|".join(_SIMPLE_HINTS), re.IGNORECASE)

# Hard recurrence markers — if any of these fire, complex wins even if
# a simple hint also matched. "leetcode every day tonight" is still
# complex because of `every day`.
_HARD_COMPLEX_PATTERNS: tuple[str, ...] = (
    r"\bdaily\b",
    r"\bweekly\b",
    r"\bmonthly\b",
    r"\bevery\s+(day|week|month|morning|night|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    r"\bfor\s+\d+\s+(day|week|month|year)s?\b",
    r"\buntil\b",
)
_HARD_COMPLEX_RE = re.compile("|".join(_HARD_COMPLEX_PATTERNS), re.IGNORECASE)


def is_recurring(text: str) -> bool:
    """True when the utterance has a hard recurrence shape — daily /
    weekly / every <unit> / for N <unit> / until. PR-B's lock-in step
    uses this to decide whether to auto-spawn a Habit alongside the
    Promise. Tighter than `needs_game_plan` — soft markers (a bare
    "day" / "starting") don't qualify because a habit row is more
    opinionated than a probe prompt and we'd rather under-spawn than
    create a habit Daniel didn't want.
    """
    if not text:
        return False
    return bool(_HARD_COMPLEX_RE.search(text))


def needs_game_plan(text: str) -> bool:
    """Return True when the promise should trigger the lock-in probe.

    Decision order:
      1. Hard complex markers (daily / weekly / for N <unit> / until /
         every <unit>) → True, regardless of simple hints.
      2. Simple hints (tonight / tomorrow / this weekend / etc.) AND no
         soft complex markers → False.
      3. Soft complex markers (day / week / month / starting) → True.
      4. Default → False (atomic; instant lock).
    """
    if not text:
        return False
    if _HARD_COMPLEX_RE.search(text):
        return True
    if _SIMPLE_RE.search(text) and not _COMPLEX_RE.search(text):
        return False
    return bool(_COMPLEX_RE.search(text))
