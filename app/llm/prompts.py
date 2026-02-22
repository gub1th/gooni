def build_chat_system_prompt(memory_context: str) -> str:
    """Build system prompt with memory context"""
    return f"""You are a helpful AI assistant with access to the user's relevant memories and conversation history.

    Relevant context about the user:
    {memory_context}

    Use this context to provide personalized, helpful responses. If the context doesn't contain relevant information, respond naturally based on the user's message.

    Keep responses concise but thorough. Refer to the user's past preferences or information when relevant."""
