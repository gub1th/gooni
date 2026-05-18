import json
import re
import threading

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
        list_context = list_service.get_list_context(db)
        focus_context = item_service.get_active_context(db)
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

        # PERSONA leads — locked identity, all channels, overrides memory prefs.
        # Intention next so the model frames action against the user's goal.
        # cadence_block (bot mechanics) only fires on bot channels and is
        # appended via filter(None, ...) when empty on web.
        full_context = "\n\n".join(filter(None, [
            PERSONA_BLOCK,
            intention_block,
            cadence_block,
            time_block,
            state_block,
            just_extracted_block,
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
