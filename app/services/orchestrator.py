import json
import re
import threading

from ..db.models import ToolCall as ToolCallModel

from ..db.database import SessionLocal
from ..db.models import Conversation as ConvModel
from ..llm.client import llm_client
from .conversation_service import conversation_service
from .item_service import item_service
from .memory_extraction import extract_signals
from .memory_service import memory_service
from .list_service import list_service
from .trace_builder import TraceBuilder


# Cheap regex for the explicit "undo" command. Runs before the detector so
# Daniel can always reach for the override even on noisy turns.
_UNDO_FEEDBACK_RE = re.compile(
    r"\b(undo|forget|disregard|nevermind|never mind|cancel)\b.{0,30}\b(feedback|correction|last (rule|note))\b",
    re.IGNORECASE,
)


# Above this length, raw note content is summarized before injection so the
# system prompt doesn't balloon to 5K tokens for a single note.
ENTRY_SUMMARIZE_THRESHOLD = 2000


_PLAN_PROMPT = """You are Gooni's pre-action planner. Read the user's message + state and decide what should happen this turn.

USER MESSAGE: {user_msg}

YOUR CURRENT STATE:
{state}

CHAT-SURFACE TOOLS AVAILABLE: {tools_list}

ROUTER SIGNALS (auto-extracted upstream BEFORE the chat model runs — these
fire whether or not the chat model calls a tool):
  router:promise, router:todo, router:feature_request, router:tone_correction

Return strict JSON. No prose, no markdown fence.

{{
  "goal": "<one short sentence — what does Daniel actually want this turn>",
  "intended_tools": ["tool_name", ...] or [],
  "minimum_action": "<one sentence — smallest sufficient response>",
  "reasoning": "<one sentence — why this plan>"
}}

Rules:
- Venting / thinking-aloud / vague intent → intended_tools=[], minimum_action="terse empathic response, push back if commitment is fuzzy"
- Commitment statements ("i won't smoke for a week" / "imma X tonight") → router:promise fires upstream; chat reply acknowledges, optional add_focus if arc
- "remember/track Y" → save_memory or appropriate persistent tool
- "what did I commit to / show my X" → READ tool (show_list, list_todos, list_focuses, search_notes)
- Recurring-reminder asks ("remind me daily") → request_feature (capability gap)
- Don't propose tools not in TOOLS AVAILABLE
- Plan is allowed to be empty if no action is required."""


def _run_plan(
    user_msg: str,
    state_summary: str,
    tools_list: list[str],
) -> dict | None:
    """Pre-reply plan step. Returns parsed dict or None on failure.
    Single gpt-4o-mini call (~$0.0001). Fail-open."""
    if not user_msg:
        return None
    try:
        prompt = _PLAN_PROMPT.format(
            user_msg=user_msg[:600],
            state=state_summary[:500] or "(no state)",
            tools_list=", ".join(tools_list[:50]),
        )
        raw = llm_client.generate_simple_completion(
            prompt, max_tokens=300, temperature=0.0, model="gpt-4o-mini",
        )
        s = (raw or "").strip()
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*", "", s).rstrip("`").rstrip()
        parsed = json.loads(s)
        if not isinstance(parsed, dict):
            return None
        return {
            "goal": str(parsed.get("goal") or "").strip()[:200],
            "intended_tools": [
                str(t).strip()
                for t in (parsed.get("intended_tools") or [])
                if isinstance(t, str)
            ][:8],
            "minimum_action": str(parsed.get("minimum_action") or "").strip()[:240],
            "reasoning": str(parsed.get("reasoning") or "").strip()[:200],
        }
    except Exception as e:
        print(f"[plan] failed: {e}")
        return None


_VERIFY_PROMPT = """Compare this assistant reply against the actual tool audit. Did the reply make a CONCRETE state-changing claim that the audit doesn't back?

USER ASKED: {user_msg}

DRAFT REPLY: {draft}

TOOLS ACTUALLY CALLED THIS TURN (status='done' means action succeeded):
{audit}

Return strict JSON. No prose, no markdown fence.

{{"ok": true|false, "critique": "if not ok, quote the EXACT unbacked phrase from the draft and name the missing tool (one sentence); else null"}}

Rules — be CONSERVATIVE (default ok=true):
- ok=false ONLY when the draft contains an EXPLICIT past-tense state-changing
  verb tied to a specific OBJECT: "tracked X", "saved X as a memory", "added X
  to your Y list", "logged feature request X", "created focus X", "marked X
  done", "noted X in your journal", "wrote it down". If you can't quote the
  exact phrase, it's not a lie — ok=true.
- BARE words "tracked" / "noted" / "got it" / "ok" / "remembered" alone are
  NOT enough. The draft must claim a specific persisted side-effect.
- HONEST SCOPING ALWAYS ok=true:
    "I can't track that as a habit / I don't have a tool for X / loosely
    remembered, not formally tracked / only in conversation context / not
    durable / I'd need a tool for that / no recurring reminder support"
- ROUTER-LAYER CLAIMS ok=true: the orchestrator router fires promise/feature/
  tone hooks UPSTREAM of the chat model. If the draft says "captured" /
  "logged as a feature request" / "added that promise" without an explicit
  chat-side tool call, it's still ACCURATE — the router did it. ok=true.
- Tone, length, helpfulness are NEVER in scope here. Only fact-of-action.
- Empty audit + no action-claim = ok=true (default).
- Critique must be CONCRETE: include the verbatim sloppy phrase. Vague
  critiques like "may be misleading" or "could be clearer" — emit ok=true.
"""


def _run_verify(
    draft: str,
    user_msg: str,
    tool_call_ids: list[int],
    db,
) -> tuple[bool, str]:
    """Post-reply verify against ToolCall audit. Returns (ok, critique).
    Fail-open on any error — never break the chat path. ok=True means
    ship as-is; ok=False + critique means regenerate w/ correction.
    """
    if not draft:
        return True, ""
    try:
        rows: list[ToolCallModel] = []
        if tool_call_ids:
            rows = (
                db.query(ToolCallModel)
                .filter(ToolCallModel.id.in_(tool_call_ids))
                .all()
            )
        audit_lines = [
            f"- {r.tool_name} [{r.status}]" + (f" error={r.error[:80]}" if r.error else "")
            for r in rows
        ]
        audit_block = "\n".join(audit_lines) if audit_lines else "(no tools called)"
        prompt = _VERIFY_PROMPT.format(
            user_msg=(user_msg or "")[:600],
            draft=(draft or "")[:1500],
            audit=audit_block,
        )
        raw = llm_client.generate_simple_completion(
            prompt, max_tokens=200, temperature=0.0, model="gpt-4o-mini",
        )
        # Strip code fences if any.
        s = (raw or "").strip()
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*", "", s).rstrip("`").rstrip()
        parsed = json.loads(s)
        ok = bool(parsed.get("ok", True))
        critique = (parsed.get("critique") or "").strip()
        return ok, critique
    except Exception as e:
        print(f"[verify_reply] failed: {e}")
        return True, ""


# Locked identity block. Always injected at the top of the master prompt
# regardless of channel (web, telegram, whatsapp, imessage). Channel-specific
# mechanics (bubble count, blank-line splitting) live in `cadence_block` and
# only apply on bot channels.
#
# This block is identity — it overrides contradicting memory prefs at chat
# time. Edit deliberately; behavior shifts session-wide. Keep ~30-40 lines
# to leave room for dynamic blocks (state, just_extracted, memory, focuses).
PERSONA_BLOCK = """\
PERSONA — locked identity:

You are Gooni. You exist to be the brain Daniel was built without — a
single self-evolving system that remembers him, learns him deeper every
turn, and holds him accountable to what he says he wants.

Why you were built:
Daniel procrastinates. He jumps between things. He says things and
doesn't commit. He needs someone in his corner who notices the gap
between what he said and what he did, and calls it out. That's the
job. Not a chatbot. Not a coach. A presence that keeps his word
visible to him.

How you grow:
Every conversation extracts something — a promise, a tone correction,
a new fact about him. The version of you next week should know him
better than today. When you don't know something, get curious — ask one
specific question.

Voice anchor (Alfred Pennyworth — Bruce Wayne's butler):
- Dry, terse, capable. Lowercase casual. Never sycophantic.
- Steady when he's spiraling. Never panic, never melodrama.
- Loyal without sycophancy. Will say the plan is stupid. Will still help.
- Withholds praise. Earned compliments only — no "great question."
- Notices the gap between what Daniel said and what he did. Names it
  directly: "you said no weed till next week. it's day 2."

HOW DANIEL WRITES — match this register:
- Lowercase, fragments OK, typos pass through. Don't proofread.
- "lowkey" = mildly. "dumbass" = casual emphasis, not insult.
  "fr" = for real. Mirror it.
- Stacks 3-4 asks per message — answer every part. Say if they depend.
- Self-corrects mid-thought; the later sentence is the truth.
- Redirects mid-task — pivot, don't argue.

LENGTH:
- ~150 word default. ~250 hard ceiling. Tighter on reflective topics.

ANTI-PATTERNS:
- No "want me to turn that into a rule?" — just call save_memory.
- No "I'd be happy to…" / "Great question!" / "Let me…" prefixes.
- No therapy-mode phrasing ("how does that make you feel").
- When criticized: ≤3-word ack, then fix. NEVER paragraph apologies.
- Never speculate about prior tool calls — call the read tool, answer
  from output.
- Never claim absence of a capability without checking the capability
  block first.
- Don't stack 3+ action recommendations in one reply. Pick one or two
  matched to Daniel's current capacity. Expand only if he asks.

This block overrides any contradicting memory preference. Memory is for
facts; this is identity."""


def _build_ack(
    *,
    tone_rules: list[str],
    feature_titles: list[str],
    promises: list[dict],
) -> str | None:
    """Alfred-voice ack — terse, no preface, action > announcement.

    Rules:
      - One bubble. No "noted —" prefixes, no "got it:". The phrase itself
        carries the signal that it landed.
      - Reference history when natural (slip_count surfaces as "#N").
      - Multi-signal turns chain with " · " for compactness.
      - Return None when no signals fired (caller falls through to LLM).
    """
    parts: list[str] = []
    if tone_rules:
        if len(tone_rules) > 1:
            parts.append(f"{len(tone_rules)} rules sharpened")
        else:
            rule = tone_rules[0]
            quoted = rule if len(rule) <= 60 else rule[:60].rstrip() + "…"
            parts.append(quoted.lower().rstrip("."))
    if feature_titles:
        if len(feature_titles) == 1:
            parts.append(f"backlog: \"{feature_titles[0]}\"")
        else:
            head = feature_titles[0]
            parts.append(
                f"backlog: \"{head}\" (+{len(feature_titles) - 1})"
            )
    if promises:
        if len(promises) == 1:
            p = promises[0]
            slip = p.get("slip_count", 0) or 0
            summary = p.get("summary") or p.get("utterance") or ""
            if summary and len(summary) > 60:
                summary = summary[:60].rstrip() + "…"
            if slip > 0:
                parts.append(f"\"{summary}\" — slip #{slip + 1}")
            else:
                parts.append(f"\"{summary}\" tracked")
        else:
            parts.append(f"{len(promises)} promises tracked")
    if not parts:
        return None
    return " · ".join(parts)


# Back-compat alias. _build_jarvis_ack name retained for any external imports;
# the alfred-voice rewrite happens in _build_ack above.
_build_jarvis_ack = _build_ack


def _build_state_block(db) -> str:
    """Snapshot of Daniel's actionable state, injected into the master
    prompt for bot channels. Fixes the segment-#209 failure mode where
    Gooni opened "Yo" turns with a scolding guess instead of an answer
    grounded in actual todo / promise state.

    Cheap: primary todo + open count + done-today count + pending promises
    due within 24h. Caller wraps with try/except — failure here must never
    block the chat reply.
    """
    from .promise_service import list_pending as _list_pending_promises
    from .todo_service import todo_service

    lines: list[str] = []
    try:
        primary = todo_service.get_primary(db)
    except Exception:
        primary = None
    if primary is not None:
        lines.append(
            f"- primary todo: \"{primary.text}\" (state: {primary.state or 'not_yet'})"
        )

    try:
        open_todos = todo_service.list_open(db)
    except Exception:
        open_todos = []
    open_count = sum(1 for t in open_todos if not t.is_primary)
    if open_count:
        lines.append(f"- {open_count} other open todo(s)")

    try:
        done_today = todo_service.list_done_today(db)
    except Exception:
        done_today = []
    if done_today:
        lines.append(f"- {len(done_today)} todo(s) done today")

    try:
        promises = _list_pending_promises(db, limit=10)
    except Exception:
        promises = []
    if promises:
        from datetime import datetime as _dt, timedelta as _td
        cutoff = _dt.utcnow() + _td(hours=24)
        due_soon = [p for p in promises if p.inferred_due and p.inferred_due <= cutoff]
        if due_soon:
            lines.append(f"- {len(due_soon)} promise(s) due ≤24h:")
            for p in due_soon[:3]:
                summary = p.summary or p.utterance or ""
                if len(summary) > 60:
                    summary = summary[:60].rstrip() + "…"
                slip = f", slipped {p.slip_count}x" if p.slip_count else ""
                lines.append(f"  · \"{summary}\"{slip}")
        elif promises:
            lines.append(f"- {len(promises)} pending promise(s)")

    if not lines:
        return ""
    return "[your state right now]\n" + "\n".join(lines)


def _build_time_block(db) -> str:
    """Inject Daniel's current local date+time into the master prompt for
    bot channels. Fixes the WA failure mode where Gooni had no idea what
    timezone Daniel was in and either defaulted to UTC or refused to commit
    to a local time when asked.

    Pulls Settings.nudge_tz (already zoneinfo-aware for the daily scheduler).
    Caller wraps with try/except — never blocks the reply.
    """
    from ..db.models import Settings
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        return ""
    from datetime import datetime

    settings = db.query(Settings).first()
    tz_name = settings.nudge_tz if settings and settings.nudge_tz else "America/Los_Angeles"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/Los_Angeles")
    now = datetime.now(tz)
    return (
        "[current time]\n"
        f"{now.strftime('%A %b %d %Y, %I:%M %p %Z')} (Daniel's local: {tz_name})"
    )


def _build_just_extracted_block(
    *,
    tone_rules: list[str],
    feature_titles: list[str],
    promises: list[dict],
) -> str:
    """Tells the LLM what already got routed this turn. Without this the
    LLM either re-announces ("Logged feature request:…") or doesn't know
    its work was redundant. Used as injected master-prompt context.
    """
    lines: list[str] = []
    if tone_rules:
        lines.append(f"- {len(tone_rules)} tone rule(s) logged")
    for ft in feature_titles[:3]:
        lines.append(f"- backlog ticket created: \"{ft}\"")
    for p in promises[:3]:
        summary = p.get("summary") or p.get("utterance") or ""
        if len(summary) > 60:
            summary = summary[:60].rstrip() + "…"
        slip = p.get("slip_count", 0) or 0
        slip_tail = f" (slip #{slip + 1})" if slip > 0 else ""
        lines.append(f"- promise tracked: \"{summary}\"{slip_tail}")
    if not lines:
        return ""
    return (
        "[just extracted from this message — already routed, don't re-announce]\n"
        + "\n".join(lines)
    )


def _summarize_entry(text: str) -> str:
    """Cheap LLM rollup of a long note's plaintext, used as entry_context.
    Returns the summary or the raw text on failure (better than nothing).
    """
    prompt = (
        "Summarize this note in 5-8 short bullet points capturing what Daniel "
        "wrote, decisions, open questions, and anything he committed to. "
        "Skip pleasantries.\n\nNote:\n"
        f"{text[:8000]}\n\nSummary:"
    )
    try:
        out = llm_client.generate_simple_completion(prompt, max_tokens=300)
    except Exception as e:
        print(f"entry_content summarize error: {e}")
        return text[:ENTRY_SUMMARIZE_THRESHOLD]
    return (out or "").strip() or text[:ENTRY_SUMMARIZE_THRESHOLD]


class Orchestrator:
    def handle_chat(
        self,
        message: str,
        db,
        image_url: str = None,
        conversation_id: int = None,
        source: str = "web",
        entry_content: str = "",
        model: str = None,
        event_cb=None,
    ) -> tuple[str, dict | None]:
        """Unified chat handler for all sources.

        - conversation_id=None  → find/create session by source + gap logic
        - conversation_id=<id>  → use that conversation directly (note threads)
        - source                → 'web' | 'telegram' | 'imessage' | ...
        - entry_content         → original note text injected as context (web only)
        - event_cb              → optional callback(dict) for streaming events.
          When set, fires per pipeline step + per tool_start/tool_done so the
          SSE endpoint can stream live progress to the web chat UI. Failures
          are swallowed by callees — auditing never blocks the chat path.
        """
        stripped = message.strip()
        command = stripped.lower()

        # One TraceBuilder per turn — collects every step the pipeline takes
        # so the eval UI can rate them. Pipeline version is auto-stamped as
        # the first entry; the rest are appended in the order they happen.
        tb = TraceBuilder()

        # Slash commands work from any source (web, Telegram)
        if command == "/memory":
            return self._handle_memory_command(db), None

        # First-time greeting fires on bot channels (telegram, imessage, ...).
        is_first_time = source != "web" and not memory_service.has_memories(db=db)

        # Session management
        if conversation_id is not None:
            conv = db.query(ConvModel).filter(ConvModel.id == conversation_id).first()
            if conv is None:
                raise ValueError(f"Conversation {conversation_id} not found")
        else:
            conv = conversation_service.find_or_create_session(source, db)

        # For photos, save a descriptive placeholder so follow-up messages have context
        if image_url:
            saved_message = f"[Photo: {message}]" if message.strip() else "[Photo]"
        else:
            saved_message = message
        user_msg = conversation_service.add_message(conv.id, "user", saved_message, db)

        # ── Unified signal extraction ───────────────────────────────────────
        # One LLM call per turn surfaces all three signal types (tone
        # corrections, feature requests, memory candidates).
        feedback_ack: str | None = None
        feedback_tools: list[str] = []
        signals_summary: dict = {
            "tone_corrections": [],
            "feature_requests": [],
            "soft_promises": [],
            "memory_count": 0,
        }
        memory_candidates: list[dict] = []
        captured_promises: list[dict] = []
        tone_rules: list[str] = []
        feature_titles: list[str] = []
        skip_normal_reply = False

        if not image_url and saved_message.strip():
            if _UNDO_FEEDBACK_RE.search(saved_message):
                # Explicit undo command — runs before extraction so it always wins.
                removed = memory_service.deactivate_last_feedback_preference(db=db)
                if removed:
                    feedback_ack = f"rolled back — i'll drop \"{removed.content}\""
                else:
                    feedback_ack = "nothing to undo — clean slate."
                skip_normal_reply = True
                feedback_tools.append("undo_feedback")
                tb.tool_call(
                    "undo_feedback",
                    label="Undid last feedback",
                    args=None,
                    result={"removed": bool(removed), "content": removed.content if removed else None},
                )
            else:
                prev_assistant = conversation_service.get_last_assistant_message(
                    conv.id, db
                )
                prev_text = (
                    prev_assistant.content
                    if prev_assistant and prev_assistant.id != user_msg.id
                    else None
                )
                signals = extract_signals(saved_message, prev_assistant=prev_text)
                memory_candidates = signals["memories"]
                soft_promises = signals.get("soft_promises", [])
                extracted_todos = signals.get("todos", [])
                reply_intent = signals.get("reply_intent", "answer")
                signals_summary = {
                    "tone_corrections": [
                        {
                            "rule": t["rule"],
                            "evidence": t.get("evidence", ""),
                            "anti_pattern": t.get("anti_pattern", ""),
                        }
                        for t in signals["tone_corrections"]
                    ],
                    "feature_requests": [
                        {"title": f["title"], "why": f.get("why", "")}
                        for f in signals["feature_requests"]
                    ],
                    "soft_promises": [
                        {"utterance": p["utterance"], "time_hint": p.get("time_hint")}
                        for p in soft_promises
                    ],
                    "todos": [
                        {"text": t["text"], "due_hint": t.get("due_hint")}
                        for t in extracted_todos
                    ],
                    "reply_intent": reply_intent,
                    "memory_count": len(memory_candidates),
                }
                tb.extracted_signals(saved_message, signals)

                # Unified routing: one dispatch point fans signals out to
                # the per-type handlers in app/services/intent_handlers/.
                # Replaces three copy-pasted if-blocks (tone, feature,
                # promise) that drifted between chat + note-save paths.
                # Memory candidates are reconciled later off-thread or in
                # the short-circuit path — we don't route them through the
                # router here so the existing background-thread shape
                # survives.
                from . import intent_router
                ctx = intent_router.RouterContext(
                    db=db,
                    source_message_id=user_msg.id,
                    prev_assistant_text=prev_assistant.content if prev_assistant is not None else None,
                    prev_assistant_id=prev_assistant.id if prev_assistant is not None else None,
                    on_tool_call=tb.tool_call,
                )
                routed = intent_router.dispatch(
                    {
                        "tone_corrections": signals["tone_corrections"],
                        "feature_requests": signals["feature_requests"],
                        "soft_promises": soft_promises,
                        "todos": extracted_todos,
                        "reply_intent": reply_intent,
                        # memory_candidates routed separately (off-thread).
                        "memories": [],
                    },
                    ctx,
                )
                tone_rules.extend(routed.tone_rules)
                feature_titles.extend(routed.feature_titles)
                captured_promises.extend(routed.captured_promises)
                feedback_tools.extend(routed.tools_used)

                # Stamp the user message as feedback when either a tone
                # correction OR a feature request fired AND we have a
                # prior assistant turn to attribute the correction to.
                if (
                    (routed.tone_rules or routed.feature_titles)
                    and prev_assistant is not None
                ):
                    user_msg.feedback_for_message_id = prev_assistant.id
                    user_msg.is_feedback = True
                    db.commit()

                # Build the Jarvis-voice ack from whichever signals fired.
                # No structured receipts ("Feedback detected:", "Logged
                # feature request:") — Daniel called those out as too
                # clinical. Each signal contributes a natural phrase; we
                # join with light punctuation so multi-signal turns still
                # read like one breath.
                feedback_ack = _build_ack(
                    tone_rules=tone_rules,
                    feature_titles=feature_titles,
                    promises=captured_promises,
                )
                if feedback_ack is not None:
                    # Skip the LLM reply ONLY when the extractor explicitly
                    # classified the message as task_only or no_reply. The
                    # legacy pure_signal heuristic (no memory + <25 words)
                    # was over-firing — it skipped real answer-shaped turns
                    # like "give me a detailed explanation of X" because the
                    # extractor misrouted them as feature_requests. Trust
                    # reply_intent; if it says "answer" or "acknowledge",
                    # we run the full LLM reply.
                    skip_normal_reply = routed.reply_intent in ("task_only", "no_reply")

        if skip_normal_reply and feedback_ack is not None:
            tb.reply(feedback_ack, usage={"short_circuit": True})
            short_trace = tb.build()
            short_assistant_msg = conversation_service.add_message(
                conv.id, "assistant", feedback_ack, db,
                trace=json.dumps(short_trace) if short_trace else None,
            )
            # Reflexion fires even on short-circuit replies — these are the
            # exact turns most prone to the "logged, didn't act" failure mode.
            if short_assistant_msg is not None:
                from .reflexion_service import reflexion_service as _rxn
                _rxn.reflect_async(
                    user_msg=saved_message,
                    assistant_reply=feedback_ack,
                    message_id=short_assistant_msg.id,
                    conversation_id=conv.id,
                )
            # Reconcile any memory candidates off-thread even on short-circuit.
            if memory_candidates:
                threading.Thread(
                    target=memory_service.apply_memory_candidates,
                    args=(memory_candidates,),
                    daemon=True,
                ).start()
            return feedback_ack, {
                "intention": "feedback acknowledgment",
                "tools_used": feedback_tools or ["router"],
                "signals": signals_summary,
            }

        # Build recent history. If a rolling summary exists, prepend it as a
        # system-style message so long sessions retain early context past the
        # 10-message truncation window.
        recent_messages = conversation_service.get_recent_messages(conv.id, limit=10, db=db)
        recent_history = [{"role": m.role, "content": m.content} for m in recent_messages]
        if conv.summary:
            recent_history.insert(0, {
                "role": "system",
                "content": f"Conversation summary so far:\n{conv.summary}",
            })

        query = message if message.strip() else "image"

        # Pipeline-step events for the streaming UI. Each step fires its
        # event right after it produces its data — gives the web chat
        # progress dots like "Figuring out intent…" → "Pulling memories…".
        def _emit(stage: str, label: str):
            if event_cb is None:
                return
            try:
                event_cb({"type": "stage", "stage": stage, "label": label})
            except Exception as e:
                print(f"[event_cb] stage {stage} failed: {e}")

        _emit("intent", "Reading your message")
        intention_context = llm_client.generate_intention_context(query, recent_history[-6:])
        tb.intent(query, intention_context)
        _emit("memory_recall", "Pulling related memories")
        memory_context, recalled_memories = memory_service.build_memory_context_with_debug(query, db=db)
        tb.memory_recall(query, recalled_memories)
        # If the active note is large, summarize it before injection to keep
        # the prompt focused. Below threshold, dump it raw as before.
        if entry_content.strip():
            if len(entry_content) > ENTRY_SUMMARIZE_THRESHOLD:
                entry_summary = _summarize_entry(entry_content)
                entry_context = (
                    "Note the user wrote (summarized):\n\"\"\""
                    f"{entry_summary}\"\"\""
                )
            else:
                entry_context = f"Note the user wrote:\n\"\"\"{entry_content}\"\"\""
        else:
            entry_context = ""
        # list_context dump REMOVED — model fetches list contents on demand
        # via show_list tool. Was burning ~80 tokens/turn dumping titles even
        # when no list was relevant to the conversation. Tool surface already
        # covers it (app/tools/list_tools.py: ShowListTool).
        list_context = ""
        # Cosine-rank active focuses against the user's current message so we
        # only inject the top 2 most-relevant instead of dumping all 5. Avoids
        # the "every focus visible every turn" bloat that confuses multi-focus
        # cases like eval 007.
        focus_context = item_service.get_active_context(
            db, query_text=message, top_k=2
        )
        # Promote intention into the prompt so the LLM knows what Daniel is
        # trying to do right now. Previously this was computed and discarded.
        intention_block = (
            f"Daniel's current intent: {intention_context}"
            if intention_context else ""
        )
        # Bot-channel mechanics. Voice/identity/anti-patterns now live in
        # PERSONA_BLOCK (always injected). This block carries ONLY the things
        # specific to bot delivery: bubble count + blank-line splitting (the
        # split_for_bots regex needs explicit blank-line separators), plus
        # the two "context is private" rules that apply to the dynamic blocks
        # below.
        cadence_block = ""
        if source != "web":
            cadence_block = (
                "BOT DELIVERY:\n"
                "- 1 bubble default. Add a 2nd ONLY when asking a real "
                "question or surfacing state. Never more than 2.\n"
                "- ~2 sentences max per bubble.\n"
                "- For multi-bubble: separate bubbles with a BLANK LINE "
                "(\\n\\n). Never pack thoughts into one paragraph with "
                "internal single-line breaks.\n"
                "- TEMPORAL GROUNDING: if Daniel asks about a PAST time "
                "(\"last month\", \"yesterday\", \"last week\") and you only "
                "have current state, SAY SO. Never surface current state as "
                "if it answers the past question. Pattern: \"no record of "
                "[that timeframe]. current is X.\"\n"
                "- BLOCK CONTENT IS PRIVATE: the [your state right now], "
                "[current time], and [just extracted…] blocks are CONTEXT "
                "for you, not lines to echo back. Never paste rule text "
                "(\"make explanations shorter\") or block headers into your "
                "reply. Use the info, don't copy it."
            )
        # State-grounded openers — fixes T1 of segment #209 where "Yo" got
        # a scolding guess instead of a state-grounded reply. Bot channels
        # only (web has its own UI showing this state).
        state_block = ""
        just_extracted_block = ""
        time_block = ""
        if source != "web":
            try:
                state_block = _build_state_block(db)
            except Exception as e:
                print(f"[state_block] build failed: {e}")
            try:
                just_extracted_block = _build_just_extracted_block(
                    tone_rules=tone_rules,
                    feature_titles=feature_titles,
                    promises=captured_promises,
                )
            except Exception as e:
                print(f"[just_extracted_block] build failed: {e}")
            try:
                time_block = _build_time_block(db)
            except Exception as e:
                print(f"[time_block] build failed: {e}")

        # ── ReAct PLAN step ────────────────────────────────────────────
        # Pre-reply LLM call that emits explicit goal + minimum_action +
        # intended_tools, injected back into the chat prompt so the model
        # follows a derived plan instead of ad-hoc reasoning.
        #
        # GATING: skip plan on short non-actionable turns. Empirically the
        # plan over-anchors short eval cases (Daniel's eval ladder dipped
        # v6→v7 because plan_block was firing on 1-line "what's the diff
        # between X and Y" turns and producing a "Goal: explain X vs Y"
        # that ate context without value). Only fire when the turn is
        # multi-part OR carries actionable extracted signals.
        plan_block = ""
        _has_action_signals = bool(
            (signals_summary or {}).get("feature_requests")
            or (signals_summary or {}).get("tone_corrections")
            or ((signals_summary or {}).get("memory_count") or 0)
            or (signals_summary or {}).get("soft_promises")
            or captured_promises
        )
        _should_plan = (
            len(message) > 80
            or _has_action_signals
        )
        if _should_plan:
            try:
                from ..tools import registry as _tools_registry
                _tool_names = [t.name for t in _tools_registry]
                _plan_state = intention_block or ""
                _plan = _run_plan(message, _plan_state, _tool_names)
                if _plan:
                    tb.step("plan", _plan.get("goal") or "(plan)", meta=_plan)
                    _goal = _plan.get("goal") or ""
                    _action = _plan.get("minimum_action") or ""
                    if _goal or _action:
                        plan_block = (
                            "YOUR PLAN THIS TURN (self-derived — follow it, "
                            "don't echo it back):\n"
                            + (f"- Goal: {_goal}\n" if _goal else "")
                            + (f"- Action: {_action}" if _action else "")
                        )
            except Exception as e:
                print(f"[plan_block] failed: {e}")

        # Conv-level rollup of recent self-reflections — one compressed
        # paragraph of recurring failure modes in THIS conversation. Built
        # offline by reflexion_service.rollup_conversation (manual trigger
        # or periodic), injected here as a "self-aware preamble" so Gooni
        # can adapt mid-conv instead of repeating the same mistake.
        rollup_block = ""
        try:
            from .reflexion_service import reflexion_service
            rollup = reflexion_service.latest_rollup_for(db, conv.id)
            if rollup and rollup.gap_exposed:
                rollup_block = (
                    "Recent patterns in this conversation "
                    "(self-observed, don't echo back):\n"
                    f"- {rollup.gap_exposed.strip()}"
                )
        except Exception as e:
            print(f"[rollup_block] build failed: {e}")

        # PERSONA leads — locked identity, all channels, overrides memory prefs.
        # Intention next so the model frames action against the user's goal.
        # cadence_block (bot mechanics) only fires on bot channels and is
        # appended via filter(None, ...) when empty on web.
        full_context = "\n\n".join(filter(None, [
            PERSONA_BLOCK,
            intention_block,
            plan_block,
            cadence_block,
            time_block,
            state_block,
            just_extracted_block,
            rollup_block,
            memory_context,
            entry_context,
            list_context,
            focus_context,
        ]))
        tb.master_prompt(full_context, recent_history)
        _emit("generate", "Thinking")

        if image_url:
            response, usage = llm_client.generate_response_with_image(
                message, image_url, full_context, recent_history,
                db=db, conversation_id=conv.id,
            )
        else:
            response, usage = llm_client.generate_chat_response_with_memory(
                message, full_context, recent_history,
                is_first_time=is_first_time, db=db, model=model,
                conversation_id=conv.id,
                event_cb=event_cb,
            )

        # ── ReAct VERIFY step ──────────────────────────────────────────
        # Catches the msg #999 / msg #1011 class: assistant claims an
        # action ("tracked", "saved", "added") that no tool_call actually
        # backs. Compare draft reply against ToolCall audit; if mismatch,
        # regenerate ONCE with the critique embedded in the prompt so the
        # model corrects itself. Image path skipped (no audit semantics
        # on vision turns, and the regenerate cost is real).
        if not image_url:
            try:
                verify_ok, verify_critique = _run_verify(
                    response,
                    user_msg=message,
                    tool_call_ids=(usage or {}).get("tool_call_ids") or [],
                    db=db,
                )
                tb.step(
                    "verify",
                    "OK" if verify_ok else f"REVISE: {verify_critique[:120]}",
                    meta={"ok": verify_ok, "critique": verify_critique},
                )
                # Skip regenerate when critique is too short — under 30 chars
                # is almost always vague noise ("may be misleading", "could be
                # clearer"). The verify prompt now requires a verbatim quoted
                # phrase + named missing tool; if it didn't deliver that, we
                # trust the draft over the gate. Cuts down on regenerate-thrash
                # that was causing the v6/v7 eval pass-count dip.
                if not verify_ok and len((verify_critique or "").strip()) >= 30:
                    revised_context = (
                        full_context
                        + "\n\n[VERIFY CORRECTION — your draft reply claimed "
                        + "something your tool calls didn't back. Be accurate:]\n"
                        + f"- specific issue: {verify_critique}\n"
                        + "- If you didn't actually call the tool, SAY so "
                        + "honestly (\"only in convo context, not formally tracked\"). "
                        + "Don't double down."
                    )
                    response2, usage2 = llm_client.generate_chat_response_with_memory(
                        message, revised_context, recent_history,
                        is_first_time=is_first_time, db=db, model=model,
                        conversation_id=conv.id,
                        event_cb=event_cb,
                    )
                    response = response2
                    # Merge tool_call_ids across draft + revision.
                    merged_ids = list(
                        ((usage or {}).get("tool_call_ids") or [])
                    ) + list(((usage2 or {}).get("tool_call_ids") or []))
                    usage = (usage2 or {})
                    usage["tool_call_ids"] = merged_ids
            except Exception as e:
                # Fail-open: never break chat on a verify failure.
                print(f"[verify] step failed (ignored): {e}")

        # Mixed turn (feedback + new question): prepend the ack so Daniel
        # sees that the correction was logged before the actual answer.
        if feedback_ack is not None:
            response = f"{feedback_ack}\n\n{response}"

        tb.reply(response, usage=usage)
        full_trace = tb.build()
        assistant_msg = conversation_service.add_message(
            conv.id, "assistant", response, db,
            trace=json.dumps(full_trace) if full_trace else None,
        )

        # Backfill message_id on the ToolCall rows that the LLM client
        # wrote during this turn. They were inserted with message_id=NULL
        # because the assistant Message didn't exist yet; now stitch them
        # to the row that "claims" their work. See app/db/models.py::ToolCall.
        tool_call_ids = usage.get("tool_call_ids") or []
        if tool_call_ids and assistant_msg is not None:
            try:
                from ..db.models import ToolCall
                db.query(ToolCall).filter(ToolCall.id.in_(tool_call_ids)).update(
                    {"message_id": assistant_msg.id}, synchronize_session=False,
                )
                db.commit()
            except Exception as e:
                print(f"[tool_call audit] message_id backfill failed: {e}")

        # Reconcile memory candidates that the unified extractor already
        # surfaced. Avoids the second LLM call the legacy add_exchange path
        # used to make per turn. Fire-and-forget so the response isn't
        # blocked by reconcile.
        if memory_candidates:
            threading.Thread(
                target=memory_service.apply_memory_candidates,
                args=(memory_candidates,),
                daemon=True,
            ).start()

        # Per-turn reflexion (Shinn et al. — see services/reflexion_service.py).
        # Runs in its own thread with its own SessionLocal, never blocks the
        # reply path. Fires AFTER the ToolCall message_id backfill above so
        # the reflexion thread sees its tools stitched to this message row.
        if assistant_msg is not None:
            from .reflexion_service import reflexion_service as _rxn
            _rxn.reflect_async(
                user_msg=saved_message,
                assistant_reply=response,
                message_id=assistant_msg.id,
                conversation_id=conv.id,
            )

        # Refresh the rolling conversation summary every N messages. Also
        # off-thread — adds an LLM call but shouldn't block the user.
        threading.Thread(
            target=self._summarize_conv_async,
            args=(conv.id,),
            daemon=True,
        ).start()

        usage["intention"] = intention_context
        usage["signals"] = signals_summary
        if feedback_tools:
            existing_tools = list(usage.get("tools_used") or [])
            usage["tools_used"] = existing_tools + feedback_tools

        return response, usage

    def _summarize_conv_async(self, conversation_id: int) -> None:
        sess = SessionLocal()
        try:
            conversation_service.maybe_summarize(conversation_id, sess)
        except Exception as e:
            print(f"conv summarize async error: {e}")
        finally:
            sess.close()

    def _handle_memory_command(self, db) -> str:
        memories = memory_service.get_all(db=db)
        if not memories:
            return "No memories yet."
        lines = [f"Memory ({len(memories)} entries):"]
        for m in memories:
            lines.append(f"  - {m.get('content') or m.get('memory', '')[:120]}")
        return "\n".join(lines)


Orchestrator = Orchestrator()
