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
from ..llm.prompts import PLAN_MODE_PROMPT
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
        source: str = "telegram",
        entry_content: str = "",
        model: str = None,
        mode: str | None = None,
    ) -> tuple[str, dict | None]:
        """Unified chat handler for all sources.

        - conversation_id=None  → find/create session by source + gap logic
        - conversation_id=<id>  → use that conversation directly (note threads)
        - source                → 'telegram' | 'web' (determines session bucket)
        - entry_content         → original note text injected as context (web only)
        - mode                  → "plan" engages PLAN_MODE_PROMPT; None = chat
        """
        stripped = message.strip()
        command = stripped.lower()

        # Slash commands work from any source (web, Telegram)
        if command == "/memory":
            return self._handle_memory_command(db), None

        # First-time greeting only for Telegram
        is_first_time = source == "telegram" and not memory_service.has_memories(db=db)

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
            "memory_count": 0,
        }
        memory_candidates: list[dict] = []
        skip_normal_reply = False

        if not image_url and saved_message.strip():
            if _UNDO_FEEDBACK_RE.search(saved_message):
                # Explicit undo command — runs before extraction so it always wins.
                removed = memory_service.deactivate_last_feedback_preference(db=db)
                if removed:
                    feedback_ack = f"Feedback removed: \"{removed.content}\"."
                else:
                    feedback_ack = "No active feedback to undo."
                skip_normal_reply = True
                feedback_tools.append("undo_feedback")
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
                signals_summary = {
                    "tone_corrections": [
                        {"rule": t["rule"]} for t in signals["tone_corrections"]
                    ],
                    "feature_requests": [
                        {"title": f["title"], "why": f.get("why", "")}
                        for f in signals["feature_requests"]
                    ],
                    "memory_count": len(memory_candidates),
                }

                tone_rules: list[str] = []
                if signals["tone_corrections"] and prev_assistant is not None:
                    user_msg.feedback_for_message_id = prev_assistant.id
                    user_msg.is_feedback = True
                    db.commit()
                    feedback_tools.append("router:tone")
                    for t in signals["tone_corrections"]:
                        rule = t["rule"]
                        tone_rules.append(rule)
                        threading.Thread(
                            target=memory_service.add_feedback_preference,
                            args=(rule, prev_assistant.content),
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
                    except Exception as e:
                        print(f"feature_request via router error: {e}")
                    if prev_assistant is not None:
                        user_msg.feedback_for_message_id = prev_assistant.id
                        user_msg.is_feedback = True
                        db.commit()

                # Build the ack from whichever signals fired. Multi-signal
                # turns get a combined line so Daniel sees what landed where.
                ack_parts: list[str] = []
                if tone_rules:
                    ack_parts.append(
                        f"Feedback detected: {tone_rules[0]}."
                        + (f" (+{len(tone_rules) - 1} more)" if len(tone_rules) > 1 else "")
                    )
                if feature_titles:
                    titles_joined = ", ".join(f'"{t}"' for t in feature_titles[:2])
                    ack_parts.append(
                        f"Logged feature request: {titles_joined}"
                        + (f" (+{len(feature_titles) - 2} more)" if len(feature_titles) > 2 else "")
                        + "."
                    )
                if ack_parts:
                    feedback_ack = " ".join(ack_parts)
                    if tone_rules:
                        feedback_ack += " Say \"undo last feedback\" to revert."
                    # Skip the LLM reply only when the message was *purely*
                    # tone/feature signal — heuristic: no extracted memories
                    # AND ack is short. Otherwise fall through so Daniel
                    # gets a real answer to his actual question.
                    pure_signal = (
                        not memory_candidates
                        and len(saved_message.split()) < 25
                    )
                    skip_normal_reply = pure_signal

        if skip_normal_reply and feedback_ack is not None:
            conversation_service.add_message(conv.id, "assistant", feedback_ack, db)
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

        intention_context = llm_client.generate_intention_context(query, recent_history[-6:])
        memory_context = memory_service.build_memory_context(query, db=db)
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
        plan_mode_block = PLAN_MODE_PROMPT if mode == "plan" else ""
        full_context = "\n\n".join(filter(None, [
            plan_mode_block,
            intention_block,
            memory_context,
            entry_context,
            list_context,
            focus_context,
        ]))

        if image_url:
            response, usage = llm_client.generate_response_with_image(
                message, image_url, full_context, recent_history, db=db
            )
        else:
            response, usage = llm_client.generate_chat_response_with_memory(
                message, full_context, recent_history,
                is_first_time=is_first_time, db=db, model=model,
            )

        # Mixed turn (feedback + new question): prepend the ack so Daniel
        # sees that the correction was logged before the actual answer.
        if feedback_ack is not None:
            response = f"{feedback_ack}\n\n{response}"

        conversation_service.add_message(conv.id, "assistant", response, db)

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
