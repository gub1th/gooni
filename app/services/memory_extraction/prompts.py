"""Prompt constants for the memory-extraction pipeline.

Pure string data — split out of the package body so the extraction logic
isn't buried under a ~430-line _SIGNALS_PROMPT literal.
"""

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
  "promises": [
    {{
      "kind":           "create|complete|break",
      "utterance":      "<for create — verbatim quote of Daniel's commitment/chore phrase, no rewriting>",
      "summary":        "<for create — short 3rd-person description, max 10 words>",
      "cadence":        "once|daily|n_per_week|permanent_do|permanent_never",
      "cadence_target": "<int — N for n_per_week only (6 for '6x a week'). null for every other cadence>",
      "due_date":       "<YYYY-MM-DD — resolve uttered deadlines ('by friday', 'tomorrow') from today's date. null when no deadline uttered>",
      "due_hint":       "tonight|today|tomorrow|this week|this weekend|next week|null",
      "is_important":   "true|false — true ONLY when Daniel explicitly flags importance ('this is important', 'top priority')",
      "parent_hint":    "<substring of an existing bigger commitment this nests under, ONLY when Daniel says so ('part of the cut'). null otherwise>",
      "match":          "<for complete/break — substring identifying the existing promise Daniel is closing or cancelling>"
    }}
  ],
  "reply_intent": "answer|acknowledge|task_only|no_reply",
  "memories": [
    {{
      "type": "fact" | "routine" | "constraint" | "episode",
      "key":  "snake_case_key" | null,
      "content": "natural-language description of the memory",
      "context": {{"time": null|str, "location": null|str, "scope": "global"|"contextual"}},
      "confidence": 0.0-1.0
    }}
  ]
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

  *** HARD ANTI-PATTERN — LIST-ADD ASKS ***
  Phrases of the form "add X to my <noun> list" / "add X to <list_name>"
  / "throw X on my <noun> list" / "remind me to add X to <list_name>"
  / "put X on my <noun> list" are USER CONTENT, NOT a capability gap.
  Capture-shaped content lands as a Note (tags replace lists). Emit []
  for feature_requests on these. The classifier loses calibration when
  it confuses user content with platform asks (see Cluster A bug:
  "Add to date spots list" wrongly created a BacklogTicket).
  Examples that → []:
    "add this to my date spots list"
    "add Horsefeather to date spots"
    "throw this on my reading list"
    "put bread on the groceries list"
    "remind me to add the new spot to date ideas"

  *** CONSOLIDATION — 1 CAPABILITY = 1 TICKET ***
  When a single turn mentions multiple sub-asks that all describe ONE
  underlying capability (e.g. "track my sleep", "handle nights I don't
  log a sleep time", and "use claude usage as awake-signal" all describe
  ONE capability: sleep tracking), emit ONE entry. Put the sub-asks in
  `why`. Only emit N entries when there are N GENUINELY DISTINCT
  capabilities (e.g. "add timers AND a streak tracker" → 2 entries).
  Cluster A bug: a single sleep ask fragmented into 3 tickets — the
  ack then leaked "backlog: X (+2)" with no user-readable context.
  Examples:
    "i want sleep tracking — also handle nights w/o a logged time,
     and maybe use claude activity as an awake proxy"
      → ONE entry: title="Add sleep tracking",
        why="incl. unknown sleep windows + claude-usage-as-awake proxy"
    "add timers and a streak tracker"
      → TWO entries (genuinely distinct capabilities)

- After the hard gate passes (text is NOT a question, not a list-add):
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

promises:
- THE unified actionable signal. A Promise = anything Daniel commits to
  doing (or avoiding) — one-shot chores, timed commitments, recurring
  habits, standing rules. THREE kinds — pick per entry by reading the verb.

KIND DISPATCH:
- CREATE — a new commitment is being declared.
- COMPLETE — an existing commitment is done. Verbs: "did X", "finished X",
  "close X", "done with X", "just called papi", "X is done".
- BREAK — Daniel is cancelling / giving up an existing commitment. Verbs:
  "not gonna X anymore", "scratch X", "kill X", "drop X", "skipping X",
  "gave up on X".

CREATE — `{{kind:"create", utterance, summary, cadence, cadence_target,
due_date, due_hint, is_important, parent_hint}}`:
- Fires on self-declared intent: "imma X", "i'm gonna X", "i'll X",
  "i wanna X by Y", "trying to X", "i need to X", "remind me to X",
  "add to todos: X", "todo: X", "no more X", "gym 6x a week".
- CADENCE — read the recurrence shape:
    once            → one-shot ("ship the eval by friday", "call mom
                      tomorrow", "buy milk"). THE DEFAULT when no
                      recurrence phrasing is present.
    daily           → every day ("leetcode daily", "stretch every morning")
    n_per_week      → N times weekly. cadence_target = N.
                      ("gym 6x a week" → cadence_target: 6;
                       "run 3 times a week" → cadence_target: 3)
    permanent_do    → standing do-rule with no end ("always take the
                      stairs", "im a morning person now — 6am wakeups")
    permanent_never → standing avoid-rule ("no weed", "quitting alcohol",
                      "no more doomscrolling")
- `utterance` MUST be a verbatim quote — Daniel's words, not paraphrased.
  Preserves voice for the follow-up ("you said 'X' — still on?").
- `summary` = clean 3rd-person rewrite, max 10 words.
- `due_date`: when Daniel utters a deadline, resolve it to an absolute
  YYYY-MM-DD using today's date (given below). "by friday" → that friday;
  "tomorrow" → today+1. null when no deadline was uttered. Never a past
  date. Recurring cadences usually have null due_date (no single deadline).
- `due_hint` mirrors the natural-language phrase used ("tonight",
  "this week") — backend fallback parser. null when no time anchor.
- `is_important`: true ONLY on explicit importance flagging ("this is
  important", "top priority", "big one"). NEVER inferred from content.
- `parent_hint`: ONLY when Daniel explicitly nests it under a bigger
  running commitment ("part of the cut", "for the gooni rewrite") —
  substring identifying that parent. null otherwise.
- DO NOT emit create when:
  - The verb is asking Gooni for a capability ("can you remind me at 8am
    every day" = Gooni has no scheduled outbound pings — feature_request).
    BUT a bare self-commitment with recurrence ("imma drink water every
    morning") IS a create with cadence=daily — the ask/self-commit line
    is who does the work: Gooni-does-it → feature_request; Daniel-does-it
    → promise.
  - Daniel reports a completed action ("just shipped X" — that's either
    kind=complete on an existing promise, or an episode memory).
  - Aspiration with no commitment verb ("man, leetcode would be nice").
- Examples (fires):
    Text "imma finish that DSA video tonight" →
      {{kind:"create", utterance:"imma finish that DSA video tonight",
        summary:"finish DSA video", cadence:"once", due_hint:"tonight"}}
    Text "gym 6x a week starting now" →
      {{kind:"create", utterance:"gym 6x a week starting now",
        summary:"gym six times a week", cadence:"n_per_week",
        cadence_target:6}}
    Text "ship the memory eval by friday" →
      {{kind:"create", utterance:"ship the memory eval by friday",
        summary:"ship memory eval", cadence:"once",
        due_date:"<that friday as YYYY-MM-DD>"}}
    Text "no more weed" →
      {{kind:"create", utterance:"no more weed", summary:"no weed",
        cadence:"permanent_never"}}
    Text "remind me to take out trash tonight" →
      {{kind:"create", utterance:"remind me to take out trash tonight",
        summary:"take out trash", cadence:"once", due_hint:"tonight"}}
- Examples (skip):
    "Can you remind me to call mom?" → feature_request, not promise.
    "Wish i could leetcode more" → [] (no commitment verb).
    "saw a cool paper today" → [] (passive dump — no signal).

COMPLETE — `{{kind:"complete", match:"..."}}`:
- Daniel signals an existing commitment is DONE. The router cosine-matches
  `match` against active promises and flips it to kept.
- `match` = the OBJECT (the existing promise's text or close paraphrase).
  DO NOT include the done-verb.
- Examples:
    Text "close call paip" → [{{kind:"complete", match:"call paip"}}]
    Text "finished the auth bug fix" → [{{kind:"complete", match:"auth bug"}}]
    Text "just called papi" → [{{kind:"complete", match:"call papi"}}]
    Text "did the gym thing" → [{{kind:"complete", match:"gym"}}]
- NEVER emit a create alongside for the same commitment.

BREAK — `{{kind:"break", match:"..."}}`:
- Daniel cancels / abandons an existing commitment. Router matches and
  flips it to broken.
- Examples:
    Text "scratch the leetcode thing" → [{{kind:"break", match:"leetcode"}}]
    Text "not doing the 5k anymore" → [{{kind:"break", match:"5k"}}]
    Text "kill call mom" → [{{kind:"break", match:"call mom"}}]

BATCHING — one message can carry MULTIPLE entries of different kinds.
Emit them ALL:
    "close call paip, and imma plan the track event tomorrow" →
      [{{kind:"complete", match:"call paip"}},
       {{kind:"create", utterance:"imma plan the track event tomorrow",
         summary:"plan track event", cadence:"once", due_hint:"tomorrow"}}]
- Empty when nothing commitment-shaped fires. Passive dumps, questions,
  journal entries, groceries lists → [].

reply_intent:
- One-of: "answer" | "acknowledge" | "task_only" | "no_reply".
- Tells the orchestrator how much reply the user actually wants/needs.
  Phase 5: future-Gooni uses this to gate the LLM-reply step (skip the
  full generation for task_only/no_reply intents — just persist signals).
- "answer": Daniel asked a question or expects a substantive reply.
  Default for question-shaped text.
- "acknowledge": Daniel made a statement/commitment; a brief ack is
  appropriate. "Imma call mom tonight" → acknowledge.
- "task_only": Daniel dumped a chore/list/note with no expectation of a
  conversational reply. "buy milk eggs bread" → task_only.
- "no_reply": Pure context dump or rambling; even an ack would be noise.
  "yo just thinking out loud about hardware design ideas" → no_reply.
- Default to "answer" when uncertain.

memories:
- Persistent facts about Daniel — cosine-retrieved when relevant.
- "fact" = declarative truth (includes identity-shaped aspirations,
  relationships, family, stable interests/tastes like "prefers hot coffee").
  "routine" = recurring habit. "constraint" = hard limit OR a self-named
  recurring pattern Daniel has flagged about himself. "episode" = notable
  moment.
- DO NOT emit type "preference" — that type has been retired. Anything that
  used to be a preference becomes either: (a) a behavioral rule (skip it
  here, let tone_corrections catch it), (b) a feature request (skip here,
  feature_requests catches it), or (c) a stable taste/interest about Daniel
  → emit as "fact".
- DO NOT emit "goal" — action-shaped aspirations are promise-shaped
  (the `promises` emit catches them), not memory. Skip extraction.
- key is snake_case for typed memories; null for episodes.
- scope: "global" = always applies; "contextual" = situation-specific.
- confidence: 0.85+ for explicit; 0.6-0.7 for inferences.
- Skip temporary states or one-off remarks.
- Empty when text is just a question, a thought, or a feature request with nothing
  declarative about Daniel.

- Identity / relationship / self-pattern signals — under-extracted in
  practice; fire on these even when they sound casual:
  - Family or close-relationship mentions are FACT-typed when they reveal
    durable info (who, role, dynamic). Casual references count.
      Text "buying flowers for my mom for mother's day" →
        {{type:"fact", key:"family_mom", content:"Daniel has a mother
        he wants to honor with thoughtful gestures (Mother's Day flowers
        mentioned).", scope:"global", confidence:0.85}}
      Text "my brother just moved to Austin" →
        {{type:"fact", key:"family_brother_location",
        content:"Daniel's brother lives in Austin (recent move).",
        scope:"global", confidence:0.9}}
  - Recurring self-patterns Daniel names about himself = CONSTRAINT-typed
    even though they're not hard limits, because they're load-bearing for
    every future reply. Phrasing cues: "i notice i...", "i always...",
    "i have a hard time with...", "i keep doing X", "the pattern is...".
      Text "i build productivity systems but resist being governed by them" →
        {{type:"constraint", key:"meta_resists_own_systems",
        content:"Daniel builds productivity systems but resists submitting
        to them — the friction is not having tools, it's accepting their
        rules.", scope:"global", confidence:0.85}}
      Text "i forget gooni exists when i'm scattered" →
        {{type:"constraint", key:"forgets_gooni_when_scattered",
        content:"Daniel loses recall of Gooni at the moments he most needs
        it (scattered / drifting state).", scope:"global", confidence:0.9}}
  - Identity-shaped statements ("i'm the kind of person who...", "i value
    X over Y", "i think of myself as...") = FACT-typed.
      Text "i'd rather ship ugly than polish forever" →
        {{type:"fact", key:"identity_ship_over_polish",
        content:"Daniel prefers shipping rough work to over-polishing —
        velocity over polish is a stated value.", scope:"global",
        confidence:0.9}}
- Bias for capture on these three categories. Daniel is building a memory
  store; missing a relationship or self-pattern signal is more expensive
  than emitting a near-duplicate (the reconcile step will dedupe).

If no signals across all fields, return all-empty arrays.

JSON:"""
