from ..db.schemas import InteractionCreate, MemoryCreate
from ..llm.client import llm_client
from .interaction_service import InteractionService
from .memory_service import episodic_memory_service
from .profile_memory import profile_memory_service
from .memory_extraction import memory_extraction_service
import json


class Orchestrator:
    def handle_chat(self, message: str, db) -> tuple[str, dict | None]:
        # Handle slash commands before touching the LLM
        command = message.strip().lower()
        if command == "/profile":
            return self._handle_profile_command(db), None
        if command == "/episodic":
            return self._handle_episodic_command(db), None

        # Step 1: Create user interaction
        interaction_input_user = InteractionCreate(role="user", content=message)
        InteractionService.create_interaction(interaction_input_user, db)

        # Step 2: Retrieve Profile Memory
        profile_context = profile_memory_service.build_profile_context(message, db)

        # Step 3: Retrieve Episodic Memory (RAG)
        relevant_episodes = episodic_memory_service.search_similar(message, 3, db)
        episodic_context = episodic_memory_service.build_episodic_context(relevant_episodes)

        # Step 4: Generate Response with enhanced context
        response, usage = llm_client.generate_chat_response_with_memory(
            message, profile_context, episodic_context
        )

        # Step 5: Save assistant interaction
        interaction_input_assistant = InteractionCreate(role="assistant", content=response)
        InteractionService.create_interaction(interaction_input_assistant, db)

        # Step 6: Extract and store memories
        memory_summary = self._process_memories(message, response, db)
        usage["memory"] = memory_summary

        return response, usage

    def _handle_profile_command(self, db) -> str:
        memories = profile_memory_service.get_all_active(db)
        if not memories:
            return "No profile memories yet."
        lines = [f"Profile Memory ({len(memories)} entries):"]
        for m in memories:
            lines.append(f"  [{m.memory_type.value}] {m.key}: {m.value}  (confidence: {m.confidence:.1f})")
        return "\n".join(lines)

    def _handle_episodic_command(self, db) -> str:
        memories = episodic_memory_service.get_all_memories(db)[:5]
        if not memories:
            return "No episodic memories yet."
        lines = [f"Episodic Memory (last {len(memories)}):"]
        for m in memories:
            snippet = m.content[:120].replace("\n", " ")
            if len(m.content) > 120:
                snippet += "..."
            ts = m.timestamp.strftime("%m/%d %H:%M") if m.timestamp else "?"
            lines.append(f"  [{ts}] {snippet}")
        return "\n".join(lines)

    def _process_memories(self, user_message: str, assistant_response: str, db) -> dict:
        """Extract and store both profile and episodic memories. Returns summary."""
        profile_updated = 0

        extracted_memories = memory_extraction_service.extract_profile_memories(
            user_message, assistant_response
        )
        for memory_data in extracted_memories:
            profile_memory_service.upsert_memory(memory_data, db)
            profile_updated += 1

        episodic_added = 0
        if len(user_message.strip()) > 10:
            episodic_data = MemoryCreate(
                content=f"User: {user_message}\nAssistant: {assistant_response}",
                extra=json.dumps({
                    "source": "conversation",
                    "user_message": user_message,
                    "assistant_response": assistant_response
                })
            )
            episodic_memory_service.create_memory(episodic_data, db)
            episodic_added = 1

        return {"profile_updated": profile_updated, "episodic_added": episodic_added}


Orchestrator = Orchestrator()
