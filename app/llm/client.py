import json
import os
from datetime import datetime
from typing import List, Literal

from openai import OpenAI
from pydantic import BaseModel

from ..tools import registry as tools
from ..tools import tool_map
from .pricing import UsageTracker, calculate_embedding_cost

MEMORY_EXTRACTION_PROMPT = (
    "Extract memories worth storing long-term. Each memory has a type:\n"
    "- 'fact': discrete, specific information — about the user, their projects, "
    "tools, decisions, domains they work in, things that need improvement.\n"
    "- 'preference': how the user wants Gooni to behave — response style, tone, "
    "formatting, communication preferences.\n"
    "Examples of facts: 'building Gooni with FastAPI', 'Gooni needs better memory retrieval'\n"
    "Examples of preferences: 'prefers concise responses', 'wants markdown formatting', 'wants to be addressed by a certain name', 'wants the system to be called Gooni', 'wants the system to use a certain tone'\n"
    "Rules: only include things explicitly stated (not inferred); each memory must be "
    "a single specific claim; key must be snake_case and descriptive; skip generic "
    "advice, vague statements, and filler."
)


class ExtractedMemory(BaseModel):
    key: str
    content: str
    type: Literal["fact", "preference"]


class ExtractedMemoriesOnly(BaseModel):
    memories: list[ExtractedMemory] = []


class ChatResponse(BaseModel):
    reply: str
    memories: list[ExtractedMemory] = []


class LLMClient:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.chat_model = "gpt-4o-mini"  # Cost-effective for Phase 1
        self.embedding_model = "text-embedding-3-small"

    def transcribe(self, audio_path: str) -> str:
        """Transcribe an audio file to text using Whisper."""
        with open(audio_path, "rb") as f:
            result = self.client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
            )
        return result.text

    def generate_embedding(self, text: str) -> tuple[List[float], dict]:
        """Generate embedding for text"""
        try:
            response = self.client.embeddings.create(
                model=self.embedding_model, input=text
            )
            cost = calculate_embedding_cost(
                self.embedding_model, response.usage.total_tokens
            )
            usage = {
                "embedding_tokens": response.usage.total_tokens,
                "embedding_cost": cost,
            }
            return response.data[0].embedding, usage
        except Exception as e:
            print(f"Embedding Error: {e}")
            return [], {"embedding_tokens": 0, "embedding_cost": 0}

    def generate_chat_response_with_memory(
        self,
        message: str,
        profile_context: str,
        episodic_context: str,
        history: list = None,
        is_first_time: bool = False,
        db=None,
    ) -> tuple[str, dict, list[dict]]:
        """Generate response with enhanced memory context and tool use."""

        now = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")
        system_prompt = f"""You are Gooni, a personal AI assistant with persistent memory. You help the user think, plan, reflect, and track their life across notes and conversations.

                        Current date and time: {now}

                        {profile_context}

                        {episodic_context}

                        How you work:
                        - You have access to the user's active note (if provided) — use it as context when answering questions or giving feedback
                        - When users log food or meals, call log_meal — estimate macros for each item
                        - When users log a workout, call log_workout with ONLY the exercises explicitly mentioned in the current message
                        - When users ask about macros or nutrition, call get_daily_macros
                        - When users ask about exercise progress, call get_exercise_history
                        - Keep responses short and direct
                        - Never ask more than one question at a time"""

        if is_first_time:
            system_prompt += "\n\nYou're meeting this user for the first time. Introduce yourself briefly and ask for their name."

        messages = [{"role": "system", "content": system_prompt}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})

        tool_schemas = [t.to_openai_schema() for t in tools]
        tracker = UsageTracker(self.chat_model)
        tools_used = []

        try:
            for _ in range(5):  # cap tool call iterations
                response = self.client.chat.completions.create(
                    model=self.chat_model,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=500,
                    tools=tool_schemas,
                )

                tracker.add(response.usage)
                choice = response.choices[0]

                if choice.finish_reason == "tool_calls":
                    messages.append(choice.message)
                    for tool_call in choice.message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)
                        tool = tool_map.get(tool_name)
                        result = (
                            tool.execute(db=db, **tool_args)
                            if tool
                            else f"Unknown tool: {tool_name}"
                        )
                        tools_used.append(tool_name)
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": result,
                            }
                        )
                else:
                    # Tools are done — make one structured call for reply + log_note
                    messages.append(
                        {"role": "assistant", "content": choice.message.content}
                    )
                    messages.append(
                        {
                            "role": "user",
                            "content": f"Now respond with your final reply and any memories worth storing long-term. {MEMORY_EXTRACTION_PROMPT}",
                        }
                    )
                    structured = self.client.beta.chat.completions.parse(
                        model=self.chat_model,
                        messages=messages,
                        response_format=ChatResponse,
                        max_tokens=300,
                    )
                    tracker.add(structured.usage)
                    parsed = structured.choices[0].message.parsed
                    usage = tracker.finalize(tools_used)
                    memories = [
                        {"key": m.key, "content": m.content, "type": m.type}
                        for m in parsed.memories
                    ]
                    return parsed.reply, usage, memories

            return "I got stuck processing tool results.", tracker.finalize(tools_used)

        except Exception as e:
            print(f"LLM Error: {e}")
            return (
                "I'm having trouble generating a response right now.",
                tracker.finalize(tools_used),
            )

    def generate_response_with_image(
        self,
        message: str,
        image_url: str,
        profile_context: str = "",
        episodic_context: str = "",
        history: list = None,
        db=None,
    ) -> tuple[str, dict]:
        """Generate a fitness coaching response that includes an image.

        Uses gpt-4o for vision + tool support. image_url can be an https:// URL or a
        base64 data URI (data:image/jpeg;base64,...).
        """
        vision_model = "gpt-4o"
        now = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")

        system_prompt = (
            f"You are Gooni, a personal AI assistant with persistent memory. "
            f"Current date and time: {now}\n\n"
            f"{profile_context}\n\n"
            f"{episodic_context}\n\n"
            "The user has sent you a photo. Identify what you see. "
            "If it's food, estimate macros for each item and call log_meal. "
            "If it's a workout, call log_workout. "
            "Keep your response short — confirm what was logged."
        )

        messages = [{"role": "system", "content": system_prompt}]
        if history:
            messages.extend(history)

        user_content = []
        if message.strip():
            user_content.append({"type": "text", "text": message})
        user_content.append({"type": "image_url", "image_url": {"url": image_url}})
        messages.append({"role": "user", "content": user_content})

        tool_schemas = [t.to_openai_schema() for t in tools]
        tracker = UsageTracker(vision_model)
        tools_used = []

        try:
            for _ in range(5):
                response = self.client.chat.completions.create(
                    model=vision_model,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=500,
                    tools=tool_schemas,
                )
                tracker.add(response.usage)
                choice = response.choices[0]

                if choice.finish_reason == "tool_calls":
                    messages.append(choice.message)
                    for tool_call in choice.message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)
                        tool = tool_map.get(tool_name)
                        result = (
                            tool.execute(db=db, **tool_args)
                            if tool
                            else f"Unknown tool: {tool_name}"
                        )
                        tools_used.append(tool_name)
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": result,
                            }
                        )
                else:
                    return choice.message.content, tracker.finalize(tools_used)

            return "I got stuck processing tool results.", tracker.finalize(tools_used)
        except Exception as e:
            print(f"LLM Vision Error: {e}")
            return "I couldn't analyze that image right now.", tracker.finalize(
                tools_used
            )

    def summarize_episode(self, user_message: str, assistant_response: str) -> str:
        """Summarize a conversation exchange into a concise, retrievable episode."""
        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Summarize the following conversation exchange in 1-3 sentences. "
                            "Be specific and concrete — capture what was discussed, any decisions made, "
                            "problems identified, or information shared. "
                            "Do not give generic advice. Do not editorialize. Just state the facts of what was discussed."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"User: {user_message}\nAssistant: {assistant_response}",
                    },
                ],
                temperature=0.3,
                max_tokens=150,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Episode summarization error: {e}")
            return f"User: {user_message}\nAssistant: {assistant_response}"

    def extract_facts(self, content: str) -> list[dict]:
        """Extract facts from any text (note, message, etc.).
        Returns [{ key, content }] — same shape as chat path facts.
        """
        try:
            structured = self.client.beta.chat.completions.parse(
                model=self.chat_model,
                messages=[
                    {
                        "role": "system",
                        "content": f"Extract memories worth storing long-term from the text. {MEMORY_EXTRACTION_PROMPT}",
                    },
                    {"role": "user", "content": content},
                ],
                response_format=ExtractedMemoriesOnly,
                max_tokens=200,
            )
            parsed = structured.choices[0].message.parsed
            return [
                {"key": m.key, "content": m.content, "type": m.type}
                for m in parsed.memories
            ]
        except Exception as e:
            print(f"Profile fact extraction error: {e}")
            return []

    async def generate_title(self, content: str) -> str:
        """Generate a short 5-word title for a note entry."""
        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {
                        "role": "user",
                        "content": f"Generate a short 5-word title for this note. Return only the title, no quotes:\n{content}",
                    }
                ],
                temperature=0.5,
                max_tokens=20,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Title generation error: {e}")
            return content[:40].strip()


# Global instance for easy import
llm_client = LLMClient()
