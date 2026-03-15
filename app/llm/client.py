import json
import os
from datetime import datetime
from typing import List

from openai import OpenAI
from pydantic import BaseModel


class ProfileFact(BaseModel):
    key: str
    content: str


class ProfileFactsOnly(BaseModel):
    profile_facts: list[ProfileFact] = []


class ChatResponse(BaseModel):
    reply: str
    profile_facts: list[ProfileFact] = []

from .pricing import calculate_embedding_cost, UsageTracker
from ..tools import registry as tools, tool_map


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
            cost = calculate_embedding_cost(self.embedding_model, response.usage.total_tokens)
            usage = {
                "embedding_tokens": response.usage.total_tokens,
                "embedding_cost": cost
            }
            return response.data[0].embedding, usage
        except Exception as e:
            print(f"Embedding Error: {e}")
            return [], {"embedding_tokens": 0, "embedding_cost": 0}

    def generate_chat_response_with_memory(
        self, message: str, profile_context: str, episodic_context: str,
        history: list = None, is_first_time: bool = False, db=None,
    ) -> tuple[str, dict]:
        """Generate response with enhanced memory context and tool use."""

        now = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")
        system_prompt = f"""You are Jarvis, a personal AI assistant with persistent memory. You help the user think, plan, reflect, and track their life across notes and conversations.

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
                        result = tool.execute(db=db, **tool_args) if tool else f"Unknown tool: {tool_name}"
                        tools_used.append(tool_name)
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result,
                        })
                else:
                    # Tools are done — make one structured call for reply + log_note
                    messages.append({"role": "assistant", "content": choice.message.content})
                    messages.append({
                        "role": "user",
                        "content": (
                            "Now respond with your final reply and any profile_facts newly learned "
                            "about the user (e.g. name, weight, height, dietary restrictions, "
                            "preferences). Only include facts explicitly stated in this conversation."
                        ),
                    })
                    structured = self.client.beta.chat.completions.parse(
                        model=self.chat_model,
                        messages=messages,
                        response_format=ChatResponse,
                        max_tokens=300,
                    )
                    tracker.add(structured.usage)
                    parsed = structured.choices[0].message.parsed
                    usage = tracker.finalize(tools_used)
                    usage["profile_facts"] = [{"key": f.key, "content": f.content} for f in parsed.profile_facts]
                    return parsed.reply, usage

            return "I got stuck processing tool results.", tracker.finalize(tools_used)

        except Exception as e:
            print(f"LLM Error: {e}")
            return "I'm having trouble generating a response right now.", tracker.finalize(tools_used)

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
            f"You are Jarvis, a personal AI assistant with persistent memory. "
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
                        result = tool.execute(db=db, **tool_args) if tool else f"Unknown tool: {tool_name}"
                        tools_used.append(tool_name)
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result,
                        })
                else:
                    return choice.message.content, tracker.finalize(tools_used)

            return "I got stuck processing tool results.", tracker.finalize(tools_used)
        except Exception as e:
            print(f"LLM Vision Error: {e}")
            return "I couldn't analyze that image right now.", tracker.finalize(tools_used)

    def extract_profile_facts(self, content: str) -> list[dict]:
        """Extract structured profile facts from any text (note, message, etc.).
        Returns [{ key, content }] — same shape as chat path profile_facts.
        """
        try:
            structured = self.client.beta.chat.completions.parse(
                model=self.chat_model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Extract profile facts about the user from the text. "
                            "Profile facts are durable personal attributes: name, age, weight, height, "
                            "dietary restrictions, fitness goals, preferences, injuries, etc. "
                            "Do NOT extract transient events (e.g. 'went to gym today'). "
                            "Return an empty list if nothing durable is found."
                        ),
                    },
                    {"role": "user", "content": content},
                ],
                response_format=ProfileFactsOnly,
                max_tokens=200,
            )
            parsed = structured.choices[0].message.parsed
            return [{"key": f.key, "content": f.content} for f in parsed.profile_facts]
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
