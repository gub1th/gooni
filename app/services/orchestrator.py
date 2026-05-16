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
from . import promise_service
from .trace_builder import TraceBuilder
from ..tools.feature_request_tool import feature_request_tool


# Cheap regex for the explicit "undo" command. Runs before the detector so
# Daniel can always reach for the override even on noisy turns.
_UNDO_FEEDBACK_RE = re.compile(
    r"\b(undo|forget|disregard|nevermind|never mind|cancel)\b.{0,30}\b(feedback|correction|last (rule|note))\b",
    re.IGNORECASE,
)


# Above this length, raw note content is summarized before injection so the
# system prompt doesn't balloon to 5K tokens for a single note.
ENTRY_SUMMARIZE_THRESHOLD = 2000


def _build_jarvis_ack(
    *,
    tone_rules: list[str],
    feature_titles: list[str],
    promises: list[dict],
) -> str | None:
    """Compose a natural, confidence-projecting acknowledgement when any
    signal fired this turn. Replaces the old "Feedback detected: ... /
    Logged feature request: ..." structured-receipt style that Daniel
    called too LLM-y.

    Voice rules:
      - Speak like a friend who took a note, not a system logging an event.
      - Mention WHAT landed (which list / which promise) so Daniel has
        confidence Gooni actually did the thing — but in passing, not as
        a bullet list. Confidence ≠ hallucinating.
      - Multi-signal turns chain with " — " or comma, never bullet style.
      - Return None when no signals fired (caller falls through to LLM).

    Phrases are deterministic for v1 — easy to test, fast, free of LLM
    cost. A future PR can swap in a tiny LLM call per ack if the variety
    matters, but the cost stops being free.
    """
    parts: list[str] = []
    if tone_rules:
        rule = tone_rules[0]
        if len(tone_rules) > 1:
            parts.append(f"noted — sharper next time ({len(tone_rules)} rules)")
        else:
            # Quote the rule briefly so Daniel can see it landed as intended.
            quoted = rule if len(rule) <= 60 else rule[:60].rstrip() + "…"
            parts.append(f"noted — {quoted.lower().rstrip('.')}")
    if feature_titles:
        if len(feature_titles) == 1:
            parts.append(f"on the backlog: \"{feature_titles[0]}\"")
        else:
            head = feature_titles[0]
            parts.append(
                f"on the backlog: \"{head}\" (+{len(feature_titles) - 1} more)"
            )
    if promises:
        if len(promises) == 1:
            p = promises[0]
            due = p.get("inferred_due")
            tail = ""
            if due:
                tail = " — i'll check in"
            slip = p.get("slip_count", 0) or 0
            if slip > 0:
                tail = f" — heads up, you've slipped this one {slip}x before"
            summary = p.get("summary") or p.get("utterance") or ""
            parts.append(f"got it: \"{summary}\"{tail}")
        else:
            parts.append(f"got {len(promises)} promises — i'll be in touch")
    if not parts:
        return None
    return " · ".join(parts)


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
                    "memory_count": len(memory_candidates),
                }
                tb.extracted_signals(saved_message, signals)

                tone_rules: list[str] = []
                if signals["tone_corrections"] and prev_assistant is not None:
                    user_msg.feedback_for_message_id = prev_assistant.id
                    user_msg.is_feedback = True
                    db.commit()
                    feedback_tools.append("router:tone")
                    for t in signals["tone_corrections"]:
                        rule = t["rule"]
                        evidence = t.get("evidence", "")
                        anti_pattern = t.get("anti_pattern", "")
                        tone_rules.append(rule)
                        tb.tool_call(
                            "router:tone",
                            label="Captured tone correction",
                            args={
                                "rule": rule,
                                "evidence": evidence,
                                "anti_pattern": anti_pattern,
                            },
                        )
                        threading.Thread(
                            target=memory_service.add_feedback_preference,
                            args=(rule, prev_assistant.content),
                            kwargs={"anti_pattern": anti_pattern},
                            daemon=True,
                        ).start()

                feature_titles: list[str] = []
                for fr in signals["feature_requests"]:
                    try:
                        feature_request_tool.execute(
                            db=db,
                            title=fr["title"],
                            why=fr.get("why") or saved_message[:300],
                        )
                        feature_titles.append(fr["title"])
                        feedback_tools.append("router:feature_request")
                        tb.tool_call(
                            "router:feature_request",
                            label="Logged feature request",
                            args={"title": fr["title"], "why": fr.get("why") or ""},
                        )
                    except Exception as e:
                        print(f"feature_request via router error: {e}")
                    if prev_assistant is not None:
                        user_msg.feedback_for_message_id = prev_assistant.id
                        user_msg.is_feedback = True
                        db.commit()

                # Soft-promise capture — distinct from feature_request (which
                # targets Gooni). Promise = Daniel committing to himself.
                # Persisted as Promise rows w/ utters edge from source Message
                # + supports edge to closest active Focus if cosine match.
                for sp in soft_promises:
                    try:
                        time_hint = sp.get("time_hint") or ""
                        # Compose utterance + time_hint so the regex parser
                        # in promise_service has a fighting chance at finding
                        # the anchor (LLM may have stripped it from the verb
                        # phrase when summarizing the utterance).
                        utter_for_parse = sp["utterance"]
                        if time_hint and time_hint not in utter_for_parse.lower():
                            utter_for_parse = f"{utter_for_parse} {time_hint}"
                        try:
                            from .promise_service import _infer_due_from_text
                            inferred = _infer_due_from_text(utter_for_parse)
                        except Exception:
                            inferred = None
                        p = promise_service.create(
                            db,
                            utterance=sp["utterance"],
                            summary=sp.get("summary"),
                            source_message_id=user_msg.id,
                            inferred_due=inferred,
                        )
                        captured_promises.append(promise_service.serialize(p))
                        feedback_tools.append("router:promise")
                        tb.tool_call(
                            "router:promise",
                            label="Captured promise",
                            args={
                                "utterance": sp["utterance"],
                                "time_hint": time_hint or None,
                                "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
                                "slip_count": p.slip_count,
                            },
                        )
                    except Exception as e:
                        print(f"promise capture error: {e}")

                # Build the Jarvis-voice ack from whichever signals fired.
                # No structured receipts ("Feedback detected:", "Logged
                # feature request:") — Daniel called those out as too
                # clinical. Each signal contributes a natural phrase; we
                # join with light punctuation so multi-signal turns still
                # read like one breath.
                feedback_ack = _build_jarvis_ack(
                    tone_rules=tone_rules,
                    feature_titles=feature_titles,
                    promises=captured_promises,
                )
                if feedback_ack is not None:
                    # Skip the LLM reply only when the message was *purely*
                    # signal — heuristic: no extracted memories, AND short.
                    # Otherwise fall through so Daniel gets a real answer
                    # to his actual question.
                    pure_signal = (
                        not memory_candidates
                        and len(saved_message.split()) < 25
                    )
                    skip_normal_reply = pure_signal

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
        # Per-channel cadence hint. On WA/Telegram/iMessage the reply is
        # split into bubbles by `split_for_bots` (in messaging/base.py),
        # which keys off blank-line paragraph boundaries. If the LLM
        # packs multiple thoughts into a single paragraph w/ internal
        # \n line breaks, the splitter sees one bubble — Daniel called
        # this out as mechanical-feeling ("one line / newline / one
        # line / two newlines" reading off). Instruct the model
        # explicitly so the structural intent survives the wire.
        cadence_block = ""
        if source != "web":
            cadence_block = (
                "Cadence: this reply ships over WhatsApp/Telegram as separate "
                "bubbles. Structure as 1-4 short distinct thoughts, each its "
                "own paragraph separated by a BLANK LINE (i.e. \\n\\n between "
                "thoughts). Never pack multiple thoughts into one paragraph "
                "with internal single-line breaks — that flattens into one "
                "wall-of-text bubble. Each bubble should carry one complete "
                "thought, ≤ ~280 characters. Cut filler over completeness."
            )
        full_context = "\n\n".join(filter(None, [
            intention_block,
            cadence_block,
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
