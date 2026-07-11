import hashlib
import json
import os
from datetime import datetime
from typing import List

from openai import OpenAI

from ..tools import registry as tools
from ..tools import tool_map
from .openai_pricing import UsageTracker, calculate_embedding_cost
from .prompts import (
    TITLE_GENERATION_PROMPT,
    system_prompt,
    vision_prompt,
)


def _args_fingerprint(tool_args: dict) -> str:
    """Stable hash of normalized tool args — case-insensitive on strings,
    sorted keys. Used by the per-turn dedup gate to spot redundant calls
    like set_todo_state(match="X") followed by set_todo_state(match="x ").

    Strips trailing/leading whitespace + lowercases string values; leaves
    non-string values untouched. JSON-encoded with sorted keys so dict
    ordering can't fool the comparator.
    """
    def _norm(v):
        if isinstance(v, str):
            return v.strip().lower()
        if isinstance(v, dict):
            return {k: _norm(v[k]) for k in sorted(v.keys())}
        if isinstance(v, list):
            return [_norm(x) for x in v]
        return v
    try:
        payload = json.dumps(_norm(tool_args), sort_keys=True, default=str)
    except Exception:
        payload = str(tool_args)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def _execute_with_audit(
    tool,
    tool_name: str,
    tool_args: dict,
    db,
    conversation_id: int | None,
    event_cb=None,
) -> tuple[str, int | None]:
    """Run a tool, persist a ToolCall audit row, return (result, row_id).

    Row inserted with status='running' before execute, updated to
    'done'/'failed' after. message_id stays NULL — orchestrator backfills
    it once the assistant Message is created. conversation_id is set on
    insert so cross-turn queries can find in-flight rows.

    `tool` may be None (unknown tool name from the model) — we still log a
    failed row so the audit captures the hallucinated call.

    `event_cb` (optional): callable(dict) — fires with `tool_start` before
    execute and `tool_done` after. Used by the SSE streaming endpoint to
    push live tool-call cards to the web UI. Callback failures are
    swallowed so the audit/chat path stays bulletproof.
    """
    from ..db.models import ToolCall

    tc = None
    if db is not None:
        try:
            tc = ToolCall(
                conversation_id=conversation_id,
                tool_name=tool_name,
                args_json=json.dumps(tool_args, default=str)[:4000],
                status="running",
                started_at=datetime.utcnow(),
            )
            db.add(tc)
            db.commit()
            db.refresh(tc)
        except Exception as e:
            # Auditing must never break the chat path. Log and continue.
            print(f"[tool_call audit] insert failed: {e}")
            tc = None

    if event_cb is not None:
        try:
            event_cb({
                "type": "tool_start",
                "id": tc.id if tc is not None else None,
                "tool_name": tool_name,
                "args": tool_args,
            })
        except Exception as e:
            print(f"[event_cb] tool_start failed: {e}")

    if tool is None:
        result = f"Unknown tool: {tool_name}"
        status = "failed"
        error = "unknown_tool"
    else:
        try:
            raw = tool.execute(db=db, **tool_args)
            # Phase 2 (backlog #313): structured tool returns. Migrated
            # write-tools return a typed dict {kind,id,status,summary,...};
            # serialize to JSON so the LLM reads an unambiguous status enum
            # as the tool-result message (and the audit row captures the
            # same shape). Legacy tools return str → pass through unchanged.
            # This is the single serialization choke point for both the
            # text and vision tool loops.
            if isinstance(raw, (dict, list)):
                result = json.dumps(raw, default=str)
            else:
                result = raw
            status = "done"
            error = None
        except Exception as e:
            result = f"Tool {tool_name} errored: {e}"
            status = "failed"
            error = str(e)[:1000]

    if tc is not None and db is not None:
        try:
            tc.status = status
            tc.result_json = (result or "")[:4000]
            tc.error = error
            tc.finished_at = datetime.utcnow()
            db.commit()
        except Exception as e:
            print(f"[tool_call audit] update failed: {e}")

    if event_cb is not None:
        try:
            event_cb({
                "type": "tool_done",
                "id": tc.id if tc is not None else None,
                "tool_name": tool_name,
                "status": status,
                "error": error,
            })
        except Exception as e:
            print(f"[event_cb] tool_done failed: {e}")

    return result, (tc.id if tc is not None else None)


class LLMClient:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.chat_model = "gpt-5.4"
        self.embedding_model = "text-embedding-3-small"

    def transcribe(self, audio_path: str) -> str:
        """Transcribe an audio file to text using Whisper."""
        with open(audio_path, "rb") as f:
            result = self.client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
            )
        return result.text

    def synthesize_speech(self, text: str, voice: str = "fable") -> bytes:
        """Text → MP3 audio bytes via OpenAI TTS. Used when the user triggered
        a reply by VOICE — Gooni speaks it back (see routers/speech.py).

        voice="fable" is OpenAI's British-storyteller timbre — the closest fit
        to the Alfred persona; swap the default to re-cast the voice. tts-1 is
        the low-latency model (tts-1-hd trades latency for fidelity). The API
        caps input at 4096 chars; caller pre-trims but we clamp again for
        safety. Returns raw MP3 bytes."""
        resp = self.client.audio.speech.create(
            model="tts-1",
            voice=voice,
            input=text[:4000],
            response_format="mp3",
        )
        return resp.content

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
        db=None,
        model: str = None,
        conversation_id: int | None = None,
        event_cb=None,
        static_context: str = "",
    ) -> tuple[str, dict]:
        """Generate response with memory context and tool use.

        static_context = byte-stable identity blocks (PERSONA + OBJECT_KINDS)
        placed in the cached system-prompt prefix; memory_context = the
        volatile per-turn blocks. See prompts.system_prompt.
        """
        messages = [{"role": "system", "content": system_prompt(memory_context, static_context)}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})

        active_model = model or self.chat_model
        tool_schemas = [t.to_openai_schema() for t in tools]
        tracker = UsageTracker(active_model)
        tools_used = []
        tool_call_ids: list[int] = []
        # G4: per-turn dedup cache. Keys = (tool_name, args_fingerprint).
        # Values = the prior result string. When the LLM emits a second
        # call with the same fingerprint (case-insensitive, whitespace-
        # normalized), we short-circuit instead of re-executing — and we
        # tell the model the prior outcome explicitly so it can finalize
        # its reply instead of looping. Catches the WA seg 319 redundant
        # set_todo_state(match="lowest common ancestor of binary tree
        # leetcode") → set_todo_state(match="lowest common ancestor")
        # sequence where the second call's failure overwrote the first
        # call's success in the LLM's mental state.
        prior_calls: dict[tuple[str, str], str] = {}

        try:
            for _ in range(5):
                response = self.client.chat.completions.create(
                    model=active_model,
                    messages=messages,
                    # Lowered 0.7 → 0.5 (B/audit 2026-05-31): this is a
                    # tool-calling, state-grounded assistant — high temp drives
                    # both hallucination and voice drift. The Alfred texture
                    # comes from PERSONA, not sampling noise. 0.5 keeps warmth
                    # while tightening tool-use + factual grounding. EVAL-GATE
                    # this: A/B the ladder before trusting.
                    temperature=0.5,
                    # 500 was truncating mid-sentence on longer technical
                    # explanations (eval case 006 cut off explaining memory
                    # decay). Bot channel split_for_bots still caps bubbles
                    # at ≤320 char each so longer outputs degrade gracefully
                    # rather than getting clipped at the API boundary.
                    max_completion_tokens=900,
                    tools=tool_schemas,
                )
                tracker.add(response.usage)
                choice = response.choices[0]

                if choice.finish_reason == "tool_calls":
                    messages.append(choice.message)
                    for tool_call in choice.message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)
                        # G4: dedup gate. If this (tool, args) pair already
                        # ran this turn, skip the audit-logging path + tell
                        # the model the prior result + a finalize hint.
                        key = (tool_name, _args_fingerprint(tool_args))
                        if key in prior_calls:
                            redundant_msg = (
                                f"(redundant call — same args ran earlier this "
                                f"turn. prior result was: {prior_calls[key][:300]}. "
                                f"Don't retry with variants; finalize your reply "
                                f"now based on the prior outcome.)"
                            )
                            messages.append({
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": redundant_msg,
                            })
                            continue
                        tool = tool_map.get(tool_name)
                        result, tc_id = _execute_with_audit(
                            tool, tool_name, tool_args, db, conversation_id,
                            event_cb=event_cb,
                        )
                        tools_used.append(tool_name)
                        if tc_id is not None:
                            tool_call_ids.append(tc_id)
                        prior_calls[key] = result or ""
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result,
                        })
                else:
                    usage = tracker.finalize(tools_used)
                    usage["tool_call_ids"] = tool_call_ids
                    return choice.message.content, usage

            usage = tracker.finalize(tools_used)
            usage["tool_call_ids"] = tool_call_ids
            return "I got stuck processing tool results.", usage

        except Exception as e:
            print(f"LLM Error: {e}")
            usage = tracker.finalize(tools_used)
            usage["tool_call_ids"] = tool_call_ids
            return "I'm having trouble generating a response right now.", usage

    def generate_response_with_image(
        self,
        message: str,
        image_url: str,
        memory_context: str = "",
        history: list = None,
        db=None,
        conversation_id: int | None = None,
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
        tool_call_ids: list[int] = []
        # G4: same dedup gate as the text path. See generate_chat_response_with_memory.
        prior_calls: dict[tuple[str, str], str] = {}

        try:
            for _ in range(5):
                response = self.client.chat.completions.create(
                    model=vision_model,
                    messages=messages,
                    temperature=0.7,
                    max_completion_tokens=500,
                    tools=tool_schemas,
                )
                tracker.add(response.usage)
                choice = response.choices[0]

                if choice.finish_reason == "tool_calls":
                    messages.append(choice.message)
                    for tool_call in choice.message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)
                        key = (tool_name, _args_fingerprint(tool_args))
                        if key in prior_calls:
                            redundant_msg = (
                                f"(redundant call — same args ran earlier this "
                                f"turn. prior result was: {prior_calls[key][:300]}. "
                                f"Don't retry with variants; finalize your reply "
                                f"now based on the prior outcome.)"
                            )
                            messages.append({
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": redundant_msg,
                            })
                            continue
                        tool = tool_map.get(tool_name)
                        result, tc_id = _execute_with_audit(
                            tool, tool_name, tool_args, db, conversation_id
                        )
                        tools_used.append(tool_name)
                        if tc_id is not None:
                            tool_call_ids.append(tc_id)
                        prior_calls[key] = result or ""
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result,
                        })
                else:
                    usage = tracker.finalize(tools_used)
                    usage["tool_call_ids"] = tool_call_ids
                    return choice.message.content, usage

            usage = tracker.finalize(tools_used)
            usage["tool_call_ids"] = tool_call_ids
            return "I got stuck processing tool results.", usage
        except Exception as e:
            print(f"LLM Vision Error: {e}")
            usage = tracker.finalize(tools_used)
            usage["tool_call_ids"] = tool_call_ids
            return "I couldn't analyze that image right now.", usage


    async def generate_title(self, content: str) -> str:
        """Generate a short 5-word title for a conversation or note."""
        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "user", "content": f"{TITLE_GENERATION_PROMPT}{content}"}],
                temperature=0.5,
                max_completion_tokens=20,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Title generation error: {e}")
            return content[:40].strip()

    def generate_simple_completion(
        self,
        prompt: str,
        max_tokens: int = 300,
        temperature: float = 0.7,
        model: str | None = None,
    ) -> str:
        """Single-turn completion. Used for briefings, commentary, and other ad-hoc tasks.
        Pass temperature=0.0 for structured extraction calls where determinism matters.
        Pass `model` to override `self.chat_model` (e.g. "gpt-4o-mini" for cheap
        bulk classify work where quality bar is low)."""
        try:
            response = self.client.chat.completions.create(
                model=model or self.chat_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                max_completion_tokens=max_tokens,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Completion error: {e}")
            return ""

llm_client = LLMClient()
