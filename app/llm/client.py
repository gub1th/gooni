import json
import os
from typing import List, Dict

from openai import OpenAI

from ..tools import registry as tools
from ..tools import tool_map
from .pricing import UsageTracker, calculate_embedding_cost
from .prompts import (
    TITLE_GENERATION_PROMPT,
    INTENTION_GENERATION_PROMPT,
    system_prompt,
    vision_prompt,
)


class LLMClient:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.chat_model = "gpt-4o-mini"
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
        """Generate embedding for text."""
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
        memory_context: str,
        history: list = None,
        is_first_time: bool = False,
        db=None,
        model: str = None,
    ) -> tuple[str, dict]:
        """Generate response with memory context and tool use."""
        messages = [{"role": "system", "content": system_prompt(memory_context, is_first_time)}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})

        active_model = model or self.chat_model
        tool_schemas = [t.to_openai_schema() for t in tools]
        tracker = UsageTracker(active_model)
        tools_used = []

        try:
            for _ in range(5):
                response = self.client.chat.completions.create(
                    model=active_model,
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
        memory_context: str = "",
        history: list = None,
        db=None,
    ) -> tuple[str, dict]:
        """Generate a response that includes an image. Uses gpt-4o for vision."""
        vision_model = "gpt-4o"
        messages = [{"role": "system", "content": vision_prompt(memory_context)}]
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


    async def generate_title(self, content: str) -> str:
        """Generate a short 5-word title for a conversation or note."""
        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "user", "content": f"{TITLE_GENERATION_PROMPT}{content}"}],
                temperature=0.5,
                max_tokens=20,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Title generation error: {e}")
            return content[:40].strip()

    def generate_intention_context(self, query: str, recent_history: List[Dict[str, str]]) -> str:
        """Generate intention context for the given query and recent history."""
        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "system", "content": INTENTION_GENERATION_PROMPT}] + recent_history + [
                    {"role": "user", "content": query},
                ],
                temperature=0.3,
                max_tokens=150,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Intention generation error: {e}")
            return ""


llm_client = LLMClient()
