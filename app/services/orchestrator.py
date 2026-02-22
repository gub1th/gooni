from typing import Optional

from ..llm.client import llm_client
from .conversation_service import ConversationService
from .interaction_service import InteractionService
from .memory_service import MemoryService


class Orchestrator:
    def handle_chat(self, message: str, conversation_id: Optional[int], db):
        # create a new conversation if there is no existing conversation
        if conversation_id is None:
            new_convo = ConversationService.create_conversation(db)
            conversation_id = new_convo.id

        # create new user interaction
        interaction_input_user = {
            "conversation_id": conversation_id,
            "role": "user",
            "content": message,
        }
        InteractionService.create_interaction(interaction_input_user, db)

        # search existing memories
        relevant_memories = MemoryService.search_similar(message, 3, db)

        # generate response
        response = llm_client.generate_chat_response(message, relevant_memories)

        # save assistant interaction
        interaction_input_assistant = {
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": response,
        }
        assistant_interaction = InteractionService.create_interaction(
            interaction_input_assistant, db
        )

        # extract important info to memory
        MemoryService.extract_and_store(message, response, db)

        return assistant_interaction


Orchestrator = Orchestrator()
