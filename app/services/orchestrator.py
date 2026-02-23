from ..llm.client import llm_client
from .interaction_service import InteractionService
from .memory_service import MemoryService


class Orchestrator:
    def handle_chat(self, message: str, db):
        # create new user interaction
        interaction_input_user = {
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
