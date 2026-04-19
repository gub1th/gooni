from ..db.models import Conversation as ConvModel
from ..llm.client import llm_client
from .conversation_service import conversation_service
from .memory_service import memory_service
from .list_service import list_service


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
        is_first_time = source == "telegram" and not memory_service.has_memories()

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
        conversation_service.add_message(conv.id, "user", saved_message, db)

        # Build recent history from this conversation
        recent_messages = conversation_service.get_recent_messages(conv.id, limit=10, db=db)
        recent_history = [{"role": m.role, "content": m.content} for m in recent_messages]

        query = message if message.strip() else "image"

        intention_context = llm_client.generate_intention_context(query, recent_history[-6:])
        memory_context = memory_service.build_memory_context(query)
        entry_context = (
            f"Note the user wrote:\n\"\"\"{entry_content}\"\"\""
            if entry_content.strip() else ""
        )
        list_context = list_service.get_list_context(db)
        full_context = "\n\n".join(filter(None, [memory_context, entry_context, list_context]))

        if image_url:
            response, usage = llm_client.generate_response_with_image(
                message, image_url, full_context, recent_history, db=db
            )
        else:
            response, usage = llm_client.generate_chat_response_with_memory(
                message, full_context, recent_history,
                is_first_time=is_first_time, db=db, model=model,
            )

        conversation_service.add_message(conv.id, "assistant", response, db)

        # Let Mem0 auto-extract and store relevant memories from this exchange
        if saved_message.strip() and len(saved_message.strip()) > 10:
            memory_service.add_exchange(saved_message, response)

        usage["intention"] = intention_context

        return response, usage

    def _handle_memory_command(self, db) -> str:
        memories = memory_service.get_all()
        if not memories:
            return "No memories yet."
        lines = [f"Memory ({len(memories)} entries):"]
        for m in memories:
            lines.append(f"  - {m.get('memory', '')[:120]}")
        return "\n".join(lines)


Orchestrator = Orchestrator()
