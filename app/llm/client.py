import json
import os
from datetime import datetime
from typing import List

from openai import OpenAI

from .pricing import calculate_chat_cost, calculate_embedding_cost, UsageTracker
from .prompts import build_chat_system_prompt
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
        history: list = None
    ) -> tuple[str, dict]:
        """Generate response with enhanced memory context and tool use."""

        now = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")
        system_prompt = f"""You are an intelligent AI assistant with access to the user's profile and conversation history.

        Current date and time: {now}

        {profile_context}

        Relevant past conversations:
        {episodic_context}

        Use this information to provide personalized, contextual responses. Reference the user's preferences and past conversations when relevant.
        Keep responses natural and conversational while being helpful and accurate."""

        messages = [{"role": "system", "content": system_prompt}]
        if history:
            for interaction in history:
                messages.append({"role": interaction.role, "content": interaction.content})
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
                        result = tool.execute(**tool_args) if tool else f"Unknown tool: {tool_name}"
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
            print(f"LLM Error: {e}")
            return "I'm having trouble generating a response right now.", tracker.finalize(tools_used)

    def generate_response_with_image(
        self,
        message: str,
        image_url: str,
        profile_context: str = "",
        episodic_context: str = "",
        history: list = None,
    ) -> tuple[str, dict]:
        """Generate an accountability response that includes an image (MMS proof).

        Uses gpt-4o for vision capability. image_url can be an https:// URL or a
        base64 data URI (data:image/jpeg;base64,...).
        """
        vision_model = "gpt-4o"
        now = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")

        system_prompt = (
            f"You are Gooni, an accountability partner. "
            f"Current date and time: {now}\n\n"
            f"{profile_context}\n\n"
            f"Relevant past conversations:\n{episodic_context}\n\n"
            "The user has sent you an image as proof or for feedback. "
            "Analyze it in the context of their goals and respond with honest, "
            "encouraging accountability coaching."
        )

        messages = [{"role": "system", "content": system_prompt}]
        if history:
            for interaction in history:
                messages.append(
                    {"role": interaction.role, "content": interaction.content}
                )

        user_content = []
        if message.strip():
            user_content.append({"type": "text", "text": message})
        user_content.append({"type": "image_url", "image_url": {"url": image_url}})
        messages.append({"role": "user", "content": user_content})

        tracker = UsageTracker(vision_model)
        try:
            response = self.client.chat.completions.create(
                model=vision_model,
                messages=messages,
                temperature=0.7,
                max_tokens=500,
            )
            tracker.add(response.usage)
            return response.choices[0].message.content, tracker.finalize([])
        except Exception as e:
            print(f"LLM Vision Error: {e}")
            return "I couldn't analyze that image right now.", tracker.finalize([])

    def chat_raw(self, messages: list[dict], temperature: float = 0.8, max_tokens: int = 500) -> str:
        """Minimal chat call — no memory, no tools, no cost tracking. Used for onboarding."""
        response = self.client.chat.completions.create(
            model=self.chat_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content

    def generate_chat_response(self, message: str) -> tuple[str, dict]:
        """Generate a response without memory context"""
        system_prompt = build_chat_system_prompt("")

        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": message},
                ],
                temperature=0.7,
                max_tokens=500,
            )

            # Calculate cost using pricing module
            costs = calculate_chat_cost(
                self.chat_model,
                response.usage.prompt_tokens,
                response.usage.completion_tokens
            )

            usage = {
                "input_tokens": response.usage.prompt_tokens,
                "output_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
                "input_cost": costs["input_cost"],
                "output_cost": costs["output_cost"],
                "total_cost": costs["total_cost"]
            }

            return response.choices[0].message.content, usage

        except Exception as e:
            print(f"LLM Error: {e}")
            return "I'm having trouble generating a response right now.", {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "total_cost": 0}


# Global instance for easy import
llm_client = LLMClient()
