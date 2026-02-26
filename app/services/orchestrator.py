from ..db.schemas import InteractionCreate, MemoryCreate
from ..llm.client import llm_client
from .interaction_service import InteractionService
from .memory_service import episodic_memory_service
from .profile_memory import profile_memory_service
from .memory_extraction import memory_extraction_service
import json


class Orchestrator:
    def handle_chat(self, message: str, db):
        # Step 1: Create user interaction
        interaction_input_user = InteractionCreate(
            role="user",
            content=message,
        )
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
        interaction_input_assistant = InteractionCreate(
            role="assistant",
            content=response,
        )
        assistant_interaction = InteractionService.create_interaction(
            interaction_input_assistant, db
        )

        # Step 6: Extract and store memories
        self._process_memories(message, response, db)

        return assistant_interaction, usage

    def _process_memories(self, user_message: str, assistant_response: str, db):
        """Extract and store both profile and episodic memories"""

        # Extract profile memories
        extracted_memories = memory_extraction_service.extract_profile_memories(
            user_message, assistant_response
        )

        # Upsert each profile memory
        for memory_data in extracted_memories:
            profile_memory_service.upsert_memory(memory_data, db)

        # Store episodic memory of this conversation
        # (Optional: could be more selective about what gets stored)
        # For now, store if it contains meaningful interaction
        if len(user_message.strip()) > 10:  # Basic filter
            episodic_data = MemoryCreate(
                content=f"User: {user_message}\nAssistant: {assistant_response}",
                extra=json.dumps({
                    "source": "conversation",
                    "user_message": user_message,
                    "assistant_response": assistant_response
                })
            )
            episodic_memory_service.create_memory(episodic_data, db)


Orchestrator = Orchestrator()
