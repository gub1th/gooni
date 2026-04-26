import re
import threading

from ..db.database import SessionLocal
from ..db.models import Conversation as ConvModel
from ..llm.client import llm_client
from .conversation_service import conversation_service
from .feedback_detector import feedback_detector
from .focus_service import focus_service
from .memory_service import memory_service
from .list_service import list_service


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
    ) -> tuple[str, dict | None]:
        """Unified chat handler for all sources.

        - conversation_id=None  → find/create session by source + gap logic
        - conversation_id=<id>  → use that conversation directly (note threads)
        - source                → 'telegram' | 'web' (determines session bucket)
        - entry_content         → original note text injected as context (web only)
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

        # ── Feedback handling (text-only turns) ─────────────────────────────
        # Feedback is just chat: the user types "less eager" or similar and
        # the orchestrator stamps the message + writes a tone preference into
        # memory. Skipped for image turns since those carry no critique signal.
        feedback_ack: str | None = None
        skip_normal_reply = False
        if not image_url and saved_message.strip():
            # Explicit undo command — runs before the detector so it always wins.
            if _UNDO_FEEDBACK_RE.search(saved_message):
                removed = memory_service.deactivate_last_feedback_preference(db=db)
                if removed:
                    feedback_ack = (
                        f"Feedback removed: \"{removed.content}\"."
                    )
                else:
                    feedback_ack = "No active feedback to undo."
                skip_normal_reply = True
            else:
                prev_assistant = conversation_service.get_last_assistant_message(
                    conv.id, db
                )
                # Skip the user_msg row itself (just inserted) by checking id.
                if prev_assistant and prev_assistant.id != user_msg.id:
                    fb = feedback_detector.classify(
                        prev_assistant.content, saved_message
                    )
                    if fb["is_feedback"] and fb["rule"]:
                        user_msg.feedback_for_message_id = prev_assistant.id
                        user_msg.is_feedback = True
                        db.commit()
                        # Memory write is best-effort + off-thread to avoid
                        # blocking the reply.
                        threading.Thread(
                            target=memory_service.add_feedback_preference,
                            args=(fb["rule"], prev_assistant.content),
                            daemon=True,
                        ).start()
                        # Always-visible flag so Daniel can see at a glance
                        # that the message was logged as feedback (works the
                        # same on Telegram + web). Undo escape included so
                        # false positives are reversible without ceremony.
                        feedback_ack = (
                            f"Feedback detected: {fb['rule']}. "
                            "Say \"undo last feedback\" to revert."
                        )
                        # If the user *also* asked something new, fall through
                        # and run the normal reply pipeline. Else short-circuit.
                        skip_normal_reply = not fb["also_new_question"]

        if skip_normal_reply and feedback_ack is not None:
            conversation_service.add_message(conv.id, "assistant", feedback_ack, db)
            return feedback_ack, {
                "intention": "feedback acknowledgment",
                "tools_used": ["feedback_detector"],
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
        focus_context = focus_service.get_focus_context(db)
        # Promote intention into the prompt so the LLM knows what Daniel is
        # trying to do right now. Previously this was computed and discarded.
        intention_block = (
            f"Daniel's current intent: {intention_context}"
            if intention_context else ""
        )
        full_context = "\n\n".join(filter(None, [
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

        # Local memory pipeline (extract → reconcile → apply). Fire-and-forget
        # in a daemon thread so the response isn't blocked by 1-2 LLM calls.
        if saved_message.strip() and len(saved_message.strip()) > 10:
            threading.Thread(
                target=memory_service.add_exchange,
                args=(saved_message, response),
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
