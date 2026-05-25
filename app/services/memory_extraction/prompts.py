"""Prompt constants for the memory-extraction pipeline.

Pure string data — split out of the package body so the extraction logic
isn't buried under a ~430-line _SIGNALS_PROMPT literal.
"""

_EXTRACTION_PROMPT = """Extract structured user-profile updates from this chat exchange.

User message: {user}
Gooni reply:  {assistant}

Return ONLY a JSON array. No preamble, no markdown fence.

Schema per item:
{{
  "type": "fact" | "routine" | "constraint" | "episode",
  "key": "snake_case_key" | null,
  "content": "natural-language description of the memory",
  "context": {{"time": null|str, "location": null|str, "scope": "global"|"contextual"}},
  "confidence": 0.0-1.0
}}

Rules:
- Only extract PERSISTENT info — not temporary states or one-off remarks
- "fact" = declarative truth about Daniel. Includes long-term aspirations
  expressed as identity ("Daniel wants to be a thoughtful engineer"), AND
  stable interests / tastes / dislikes ("Daniel prefers hot coffee",
  "Daniel is interested in robotics perception"). Use cosine retrieval to
  surface these when conversation context matches.
- "routine" = recurring habit/pattern
- "constraint" = hard limit (allergies, schedule blockers, dealbreakers)
- "episode" = a notable moment from the chat itself (no key, just content)
- DO NOT extract behavioral rules about how Gooni should ACT (tone, length,
  format, voice, "be more concise", "don't use emojis"). Those belong in
  the locked PERSONA prompt, not in memory. The "preference" type used to
  catch these — it's been removed for that reason. If the candidate is a
  behavior-shaping rule for the assistant, emit [] and let the user's
  feedback flow into tone_corrections separately.
- DO NOT extract feature requests (UI changes, keyboard shortcuts,
  capability gaps). Those route to feature_requests in extract_signals,
  not into memory.
- DO NOT emit "goal" — action-shaped aspirations belong in the focuses
  list (list_items), not memory. If Daniel says "I want to ship X this
  week" / "I'm going to learn Y" with action + timeframe, skip extraction
  entirely — that's focus material, surfaced separately.
- key is snake_case (e.g. "coffee_temperature"); null for episodes
- scope: "global" = always applies; "contextual" = situation-specific
- confidence: 0.85+ for explicit statements; 0.6-0.7 for inferences
- Return [] if nothing extractable

Anti-examples — DO NOT extract these:
- A chat transcript snippet recapping the assistant's reply. Skip.
- A todo list / planning bullet ("Finish resume / Email George"). Skip.
- The assistant restating its own behavior ("I will adjust as needed"). Skip.
- "User wants Gooni to handle Markdown formatting" — behavior rule for the
  assistant. Skip (it'll get caught by tone_corrections / feature_requests
  upstream if it's a real ask).
- "Daniel wants the Publish button to be the primary CTA" — feature
  request, not a memory. Skip.

Examples:
- "I prefer hot coffee" → fact, coffee_temperature, "prefers hot coffee", global, 0.9
- "I work from home Tuesdays" → routine, tuesday_location, home, contextual, 0.85
- "Just shipped Gooni v2!" → episode, null, "shipped Gooni v2", global, 0.9
- "I'm into robotics perception" → fact, robotics_focus, "interested in robotics perception", global, 0.9

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
  "soft_promises": [
    {{
      "utterance":    "<verbatim quote of Daniel's commitment phrase, no rewriting>",
      "summary":      "<short 3rd-person description, max 10 words — for nudge subjects>",
      "time_hint":    "tonight|today|tomorrow|this week|this weekend|next week|by friday|null",
      "spawns_todo":  "true|false — true ONLY when the promise is action-shaped (concrete one-shot verb + object, e.g. 'imma text david', 'i'll fix the auth bug tonight'). false for chronic / avoidance / vague promises ('no smoke for 7 days', 'i'll be better about X', 'imma start working out more'). When true, the router auto-creates a linked Todo so the promise has a concrete actionable shadow."
    }}
  ],
  "todos": [
    {{
      "kind":         "create|delete|complete|merge|edit",
      "text":         "<for create — short imperative chore, max 12 words>",
      "due_hint":     "tonight|today|tomorrow|this week|null",
      "match":        "<for delete/complete/merge/edit — substring of the existing todo Daniel is acting on>",
      "merge_into":   "<for merge only — substring identifying the keep-target>",
      "closure_note": "<for complete only — optional short outcome text Daniel said about how it went>",
      "spawned":      [{{"text": "<follow-up chore>", "due_hint": "..."}}],
      "patch":        "<for edit only — JSON-like object with fields to change. Supported keys: text (rename), subtitle (notes), due_hint (snooze/reschedule), primary (true/false to toggle), parent_match (substring of parent todo to link as child of), unlink_parent (true to clear parent link), position ('top' | 'bottom' | 'above:<match>' | 'below:<match>'), focus_name (link this todo to the named active focus — cosine-resolved). Emit ONLY the fields Daniel actually changed. Examples: 'push X to friday' → {{patch: {{due_hint: 'this week'}}}}; 'make X primary' → {{patch: {{primary: true}}}}; 'X is a follow-up to Y' on X → {{patch: {{parent_match: 'Y'}}}}; 'X is more important than Y' on X → {{patch: {{position: 'above:Y'}}}}; 'add note about Z to X' on X → {{patch: {{subtitle: 'Z'}}}}; 'this is for forge prep' on X → {{patch: {{focus_name: 'forge prep'}}}}>"
    }}
  ],
  "done_signals": [
    {{
      "phrase": "<the verbatim done-utterance Daniel said, e.g. 'just called papi', 'finished the auth bug', 'did the gym thing'>",
      "match":  "<short substring/keyword identifying which existing open todo this corresponds to — Gooni will cosine-resolve against open todos at ≥0.85, ambiguity check on top-2 within 0.05>"
    }}
  ],
  "fitness_logs": [
    {{
      "log_type":         "food|weight|exercise|macros_explicit|substance",
      "raw_text":         "<verbatim slice Daniel logged, e.g. 'chicken rice kimchi, 2 oranges, yogurt w/ blueberries'>",
      "needs_estimation": "true|false — true ONLY for log_type=food when NO calorie/protein numbers were given",
      "metrics":          [{{"metric_type": "calories|protein", "value": 2100, "unit": "kcal|g"}}],
      "weight":           "<number, for log_type=weight only — e.g. 175>",
      "weight_unit":      "lb|kg",
      "exercise_label":   "<for log_type=exercise only — e.g. 'chest and tris'>",
      "substance":        "<for log_type=substance only — alcohol|weed|vape>",
      "correction":       "true|false — true when Daniel is amending an EARLIER log this day",
      "correction_target":"calories|protein|weight — which metric the correction overwrites"
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
  / "put X on my <noun> list" are USER CONTENT going onto an existing
  list, NOT a capability gap. Gooni already has `add_to_list` —
  these route through that tool, not the engineering backlog. Emit []
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

soft_promises:
- Daniel committing TO HIMSELF — distinct from feature_requests (which
  target Gooni). Phrasing cues: "imma X", "i'm gonna X", "i'll X",
  "i wanna X by Y", "trying to X", "gonna X tonight", "i need to X
  before Z", "promise myself i'll X". The shared signal: a self-declared
  intent with a verb + (often) a time anchor.
- DO emit when Daniel states a real intent — even if he doesn't explicitly
  say "promise". Capture the moment of declaration; that's what makes the
  accountability surface work.
- DO NOT emit when:
  - The verb is asking Gooni for help ("can you remind me to call mom" =
    feature_request shape, not a promise).
  - Daniel is reporting a completed action ("just shipped X" = episode
    memory, not a promise).
  - Daniel is venting an aspiration without a verb ("man, leetcode would
    be nice" → empty; "i'm gonna leetcode daily" → promise).
- `utterance` MUST be a verbatim quote — Daniel's words, not paraphrased.
  Preserves voice for the follow-up ("you said 'X' — still on?").
- `summary` is a clean 3rd-person rewrite for surfaces where the raw
  utterance is too long / unclear without context ("finish DSA video
  tonight").
- `time_hint` mirrors the natural-language phrase Daniel used; the
  backend parses it into an actual datetime. Use `null` when no time
  anchor was uttered.
- Examples (fires):
    Text "imma finish that DSA video tonight and solve the leetcode" →
      {{utterance:"imma finish that DSA video tonight and solve the leetcode",
        summary:"finish DSA video + solve daily leetcode",
        time_hint:"tonight"}}
    Text "i'm gonna leetcode every day this week" →
      {{utterance:"i'm gonna leetcode every day this week",
        summary:"leetcode daily this week",
        time_hint:"this week"}}
    Text "i'll call my mom tomorrow" →
      {{utterance:"i'll call my mom tomorrow", summary:"call mom",
        time_hint:"tomorrow"}}
- Examples (skip):
    "Can you remind me to call mom?" → feature_request, not promise.
    "Just finished the leetcode" → episode memory, not promise.
    "Wish i could leetcode more" → null (no commitment verb).
- Empty when no self-committal verb fired.

todos:
- Chore-shaped actionable items. FOUR action kinds — pick correctly per entry.
  Distinct from soft_promises (first-person commitments).

KIND DISPATCH — read the verb to pick:
- CREATE — new chore. Verbs: "add", "remind me to", "i need to", "todo:"
- DELETE — kill existing. Verbs: "kill", "delete", "remove", "drop",
  "scratch", "cut", "get rid of"
- COMPLETE — close existing. Verbs: "close", "done with", "finished",
  "completed", "marked done", "move X to done", "X is done", "did X"
- MERGE — combine two existing. Verbs: "merge", "combine", "X and Y are
  the same thing"

CREATE — `{{kind:"create", text:"...", due_hint:"..."}}`:
- SURFACE RULE: when `prev_assistant` is non-empty (chat surface), prefer
  soft_promises for "imma X" / "i'll X" / "i'm gonna X". Emit create on
  chat ONLY when text is explicit: "add to todos: X", "remind me to X",
  "todo: X".
- When prev_assistant is empty (note save), emit create freely for chore-
  shaped imperatives.
- The dashboard composer's "demo for gooni" use case lives here.
- RECURRING-REMINDER CARVE-OUT (READ CAREFULLY):
  "remind me to X" is a CREATE only when X happens ONCE (no time-recurrence
  modifier). Recurring-shape phrasings — "every day", "daily", "weekly",
  "every morning", "at 8am every", "every N hours", "every N days" — are
  CAPABILITY GAPS, not todos. Gooni has no recurring outbound reminder
  surface. These belong in `feature_requests`, NOT `todos`. Emit [] here
  for recurring shapes; the feature_requests handler will catch them.
  Examples (recurring → feature_request, NOT todos):
    "remind me every day at 8am to log my workout" → todos=[]
    "remind me daily to drink water" → todos=[]
    "every morning send me a focus list" → todos=[]
    "weekly digest of my todos please" → todos=[]
- Examples (single-shot → CREATE):
    Text "i need to create a demo for gooni" → [{{kind:"create", text:"create demo for gooni"}}]
    Text "call dentist tomorrow" → [{{kind:"create", text:"call dentist", due_hint:"tomorrow"}}]
    Text "buy milk + eggs" → [{{kind:"create", text:"buy milk + eggs"}}]
    Text "remind me to take out trash tonight" → [{{kind:"create", text:"take out trash", due_hint:"tonight"}}]
- Examples (chat context, skip → emits as soft_promise instead):
    Text "imma call mom tomorrow" → soft_promises, NOT todos
    Text "i'll fix the auth bug tonight" → soft_promises, NOT todos

DELETE — `{{kind:"delete", match:"..."}}`:
- Daniel signals to KILL an existing todo. The router cosine-matches `match`
  against open todos and soft-deletes the hit (24h undo).
- `match` MUST be the OBJECT of the kill — the noun phrase identifying which
  todo. DO NOT include the verb. DO NOT capture the kill as a new todo text.
- Examples:
    Text "kill texting curtis bout houselympics" →
      [{{kind:"delete", match:"texting Curtis about Houselympics"}}]
    Text "delete the trim-list-title stuff" →
      [{{kind:"delete", match:"trim-list-title"}}]
    Text "scratch call mom" → [{{kind:"delete", match:"call mom"}}]
    Text "drop the leetcode todo" → [{{kind:"delete", match:"leetcode"}}]
- NEVER emit a create alongside — the user is killing, not adding.

COMPLETE — `{{kind:"complete", match:"...", closure_note?:"...", spawned?:[{{text, due_hint?}}]}}`:
- Daniel signals an existing todo is DONE. Router cosine-matches against
  open todos and cycles state to done.
- `match` = the OBJECT (the existing todo's text or close paraphrase).
- `closure_note` (optional) — short outcome text Daniel said about HOW it went,
  what happened, the takeaway. Captures continuity ("closure ≠ end-of-thread").
- `spawned` (optional) — list of follow-up todos Daniel mentioned in the same
  message ("close X, gonna do Y next"). Each becomes a new Todo linked to the
  closed one via a spawned_from edge. NEVER emit these as separate kind=create
  entries when they're follow-ups to a close — bundle them inside the complete
  entry's spawned[] so the lineage edge gets wired.
- Examples (close only):
    Text "close call paip" → [{{kind:"complete", match:"call paip"}}]
    Text "lets close call paip" → [{{kind:"complete", match:"call paip"}}]
    Text "move filter active focuses to done" →
      [{{kind:"complete", match:"filter active focuses"}}]
    Text "finished the auth bug fix" → [{{kind:"complete", match:"auth bug"}}]
    Text "i did the dentist call" → [{{kind:"complete", match:"dentist"}}]
- Examples (close + outcome, no spawn):
    Text "closed forge prep, went well" →
      [{{kind:"complete", match:"forge prep", closure_note:"went well"}}]
    Text "did the dentist appointment. great visit." →
      [{{kind:"complete", match:"dentist", closure_note:"great visit"}}]
- Examples (close + outcome + spawn — the chain-continuity case):
    Text "close forge prep, went well, gonna schedule technical next" →
      [{{kind:"complete", match:"forge prep", closure_note:"went well",
         spawned:[{{text:"schedule technical round", due_hint:null}}]}}]
    Text "leg appointment done. now need to provide my info" →
      [{{kind:"complete", match:"leg appointment",
         spawned:[{{text:"provide info for appointment", due_hint:null}}]}}]
    Text "closed taxes prep. gonna file tonight and call cpa tomorrow" →
      [{{kind:"complete", match:"taxes prep",
         spawned:[
           {{text:"file taxes", due_hint:"tonight"}},
           {{text:"call cpa", due_hint:"tomorrow"}}
         ]}}]
- NEVER emit a create alongside — the user is closing existing work, and any
  follow-ups belong INSIDE the complete entry's spawned[] field.

MERGE — `{{kind:"merge", match:"...", merge_into:"..."}}`:
- Daniel signals two existing todos should combine. `merge_into` = the
  KEEP-target (text stays); `match` = the MERGED-IN target (soft-deleted,
  its text appended to merge_into's subtitle).
- Examples:
    Text "merge leg doctor and dermatologist todos" →
      [{{kind:"merge", merge_into:"leg doctor", match:"dermatologist"}}]
    Text "the gym and workout todos are the same — combine" →
      [{{kind:"merge", merge_into:"gym", match:"workout"}}]

BATCHING — a single message can carry MULTIPLE actions of DIFFERENT kinds.
Emit them ALL as separate entries.
- Example: "kill texting curtis bout houselympics, and plan the 100/200/400m
  one. lets move filter active focuses to done. and lets close call paip" →
    [
      {{kind:"delete",   match:"texting Curtis about Houselympics"}},
      {{kind:"create",   text:"plan the 100/200/400m event"}},
      {{kind:"complete", match:"filter active focuses"}},
      {{kind:"complete", match:"call paip"}}
    ]
- Eval-segment-280 anti-pattern (NEVER emit this shape — wrong):
    [
      {{kind:"create", text:"stop texting Curtis about Houselympics"}},
      {{kind:"create", text:"plan the 100/200/400m event"}},
      {{kind:"create", text:"move filter active focuses to done"}}
    ]
  All 3 state-changes got captured as create — that's the bug this dispatch
  fixes. Verbs first, then objects. Never paraphrase a kill into a new todo.

- Skip when text is pure capture (groceries lists, design ideas, journal
  entries) — let the prefilter handle those.
- Empty when nothing chore-shaped fires.

fitness_logs:
- Daniel logging diet / body / training data so Gooni can keep his cut
  table. These create numeric DailyMetric rows in real time — distinct
  from todos (chores) and soft_promises (commitments).

  *** HARD GATE — APPLY FIRST ***
  Questions about food/body ("how many calories in X?", "what's my protein
  today?", "should I eat more?") → emit [] for fitness_logs. Asking ≠
  logging. The reply step answers; this field stays empty.

LOG TYPES — pick per entry:
- food — Daniel names what he ate WITHOUT explicit numbers. Set
  needs_estimation=true, leave metrics=[]. The handler estimates macros.
    "chicken rice kimchi, 2 oranges, yogurt w/ blueberries"
      → {{log_type:"food", raw_text:"chicken rice kimchi, 2 oranges, yogurt w/ blueberries", needs_estimation:true, metrics:[]}}
    "had a protein shake and a banana" → food, needs_estimation:true
- macros_explicit — Daniel GIVES the numbers. needs_estimation=false, fill
  metrics[] directly (no estimation call).
    "2100 cal, 140g protein"
      → {{log_type:"macros_explicit", needs_estimation:false,
          metrics:[{{metric_type:"calories",value:2100,unit:"kcal"}},
                   {{metric_type:"protein",value:140,unit:"g"}}]}}
    "just 850 calories so far" → macros_explicit, metrics:[{{calories,850}}]
- weight — a bodyweight reading. Fill `weight` + `weight_unit` (default lb
  if Daniel gave a bare number that's plausibly bodyweight).
    "175 this morning" → {{log_type:"weight", weight:175, weight_unit:"lb"}}
    "weighed in at 79.4kg" → {{log_type:"weight", weight:79.4, weight_unit:"kg"}}
- exercise — ANY training happened: gym (push/pull/legs/upper/etc.), a
  sport (tennis, soccer), or cardio (run, bike, swim). One log_type for all
  of it. Fill exercise_label with WHAT it was — name the activity, and keep
  any sub-detail (the gym split / distance). The label is how Daniel later
  sees "what exercise was it", so make it self-describing.
    "gym today, chest and tris" → {{log_type:"exercise", exercise_label:"gym — chest and tris"}}
    "did legs at the gym" → {{log_type:"exercise", exercise_label:"gym — legs"}}
    "pull day" → {{log_type:"exercise", exercise_label:"gym — pull"}}
    "played tennis" → {{log_type:"exercise", exercise_label:"tennis"}}
    "ran 5k this morning" → {{log_type:"exercise", exercise_label:"5k run"}}
- substance — Daniel used alcohol, weed, or a vape/nicotine. Map to ONE of:
  alcohol|weed|vape. Read INTENT, not keywords:
  • alcohol = ALCOHOLIC drinks ONLY (beer/wine/liquor/cocktails/"drinks" out).
    Water, juice, coffee, soda, energy drinks, protein shakes are NOT alcohol —
    "drank" alone means nothing; it's WHAT he drank.
  • weed = cannabis. "smoked salmon"/"smoked brisket" is FOOD, not weed.
  • vape = nicotine vape/pen/juul. Water "vapor" is not a vape.
  Slang counts:
    "smoked last night" / "blazed" / "hit the j" → {{log_type:"substance", substance:"weed"}}
    "had a few beers" / "got drunk" / "hungover af" → {{log_type:"substance", substance:"alcohol"}}
    "hit the pen" / "juuled" / "vaped a bunch" → {{log_type:"substance", substance:"vape"}}
  NOT substance logs (emit nothing for these):
    "drank a ton of water today", "had a coffee", "smoked salmon for lunch"
  POSITIVE occurrence only — DON'T log abstinence ("stayed sober", "no weed
  today"); the absence is the default empty cell. One entry per substance.

CORRECTIONS — Daniel amends an earlier log from the same day:
  "actually that chicken was more like 900 cal"
    → {{log_type:"macros_explicit", correction:true, correction_target:"calories",
        metrics:[{{metric_type:"calories",value:900,unit:"kcal"}}]}}
  The handler overwrites the most-recent matching row instead of adding.

- A single message can carry MULTIPLE fitness logs (food + weight + gym) —
  emit each as its own entry.
- reply_intent for pure fitness-log messages should be "acknowledge" (a
  brief "noted, sir" ack is all Daniel wants; he's logging, not asking).
- Empty when the text carries no diet/body/training data.

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
- DO NOT emit "goal" — action-shaped aspirations belong in focuses list
  (list_items), not memory. Skip extraction; focus pipeline handles them.
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


# Tier-2 macro estimation — fired by the fitness handler ONLY when an
# extracted food log has needs_estimation=true (no numbers given). Kept
# tiny + temperature 0 so it's a sub-second, deterministic-ish add-on.
_MACRO_ESTIMATE_PROMPT = """Estimate total calories and grams of protein for what Daniel ate. Use realistic typical portions unless he specified amounts. Return ONLY JSON, no prose, no fence:

{{"calories": <int>, "protein_g": <int>}}

Food: "{food}"

JSON:"""
