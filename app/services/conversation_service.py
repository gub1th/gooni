import json

from ..common import strip_code_fence
from datetime import datetime, timezone, timedelta

from sqlalchemy.orm import Session

from ..db.models import Conversation, Message
from ..llm.client import llm_client


_GRAPH_PROMPT = """Extract the topic flow from this conversation as a JSON graph.

Each user/assistant turn is a "moment". Pull 1-3 concrete topic keywords per
moment (nouns or verb phrases — NOT generic words like "question", "follow-up",
"explanation"). If a turn has no distinct topic shift, skip it.

An edge connects parent_message_id → message_id when one turn builds on, or
branches off, an earlier topic. The first turn has no parent.

Output JSON only — no preamble, no markdown fences:
{{"nodes": [{{"id": <message_id>, "label": "<short topic>", "role": "user"|"assistant"}}, ...],
 "edges": [{{"from": <id>, "to": <id>}}, ...]}}

Conversation:
{thread}
"""


def _build_topic_graph_via_llm(messages: list[Message]) -> dict | None:
    """Single-shot LLM extraction. Returns None on parse failure — the caller
    falls back to an empty graph rather than blowing up the UI.
    """
    if not messages:
        return {"nodes": [], "edges": []}
    thread_lines = []
    for m in messages:
        text = (m.content or "").strip().replace("\n", " ")[:600]
        thread_lines.append(f"#{m.id} [{m.role}] {text}")
    prompt = _GRAPH_PROMPT.format(thread="\n".join(thread_lines))
    try:
        raw = llm_client.generate_simple_completion(prompt, max_tokens=600)
    except Exception as e:
        print(f"topic_graph LLM error: {e}")
        return None
    cleaned = strip_code_fence(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"topic_graph JSON parse error: {e} | raw: {cleaned[:200]}")
        return None
    if not isinstance(parsed, dict):
        return None
    return {
        "nodes": parsed.get("nodes") or [],
        "edges": parsed.get("edges") or [],
    }


SESSION_GAP_MINUTES = 10  # new session if last message was > 10 minutes ago

# How many messages between auto-summarization passes. The summary is
# regenerated each time the count crosses a multiple, so the most recent
# rollup always reflects (N // SUMMARIZE_EVERY_N) * SUMMARIZE_EVERY_N msgs.
SUMMARIZE_EVERY_N = 15


_SUMMARY_PROMPT = """Summarize this conversation between Daniel and Gooni in
under 200 words. Focus on what Daniel was trying to do, what was decided,
unresolved threads, and any commitments made. Skip pleasantries.

Write as a tight third-person rollup — no bullet points unless they aid clarity.

Conversation:
{thread}

Summary:"""


def _build_summary_via_llm(messages: list[Message]) -> str | None:
    if not messages:
        return None
    thread_lines = []
    for m in messages:
        text = (m.content or "").strip().replace("\n", " ")[:500]
        thread_lines.append(f"[{m.role}] {text}")
    prompt = _SUMMARY_PROMPT.format(thread="\n".join(thread_lines))
    try:
        raw = llm_client.generate_simple_completion(prompt, max_tokens=350)
    except Exception as e:
        print(f"conversation summary LLM error: {e}")
        return None
    return (raw or "").strip() or None


class ConversationService:

    # ── Session management ─────────────────────────────────────────────────────

    def find_or_create_session(self, source: str, db: Session) -> Conversation:
        """Bot channels (telegram, imessage, ...) reuse a single persistent
        conversation per source — they're always-on threads, no gap-based
        sessions. Web reuses the active conversation if last message was <
        SESSION_GAP_MINUTES ago, else opens a new one."""
        if source != "web":
            existing = (
                db.query(Conversation)
                .filter(Conversation.source == source)
                .order_by(Conversation.created_at.asc())
                .first()
            )
            if existing:
                return existing
            return self.create(source=source, db=db)

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=SESSION_GAP_MINUTES)

        existing = (
            db.query(Conversation)
            .filter(
                Conversation.source == source,
                Conversation.last_message_at >= cutoff,
            )
            .order_by(Conversation.last_message_at.desc())
            .first()
        )
        if existing:
            return existing
        return self.create(source=source, db=db)

    def create(
        self,
        db: Session,
        source: str = "web",
        title: str | None = None,
    ) -> Conversation:
        conv = Conversation(source=source, title=title)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        return conv

    # ── Messages ───────────────────────────────────────────────────────────────

    def add_message(
        self, conversation_id: int, role: str, content: str, db: Session,
        trace: str | None = None,
    ) -> Message:
        msg = Message(
            conversation_id=conversation_id, role=role, content=content,
            trace=trace,
        )
        db.add(msg)
        db.commit()
        # Update last_message_at on the conversation
        conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        if conv:
            conv.last_message_at = datetime.now(timezone.utc)
            db.commit()
        db.refresh(msg)
        return msg

    def get_messages(self, conversation_id: int, db: Session) -> list[Message]:
        return (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
            .all()
        )

    def build_topic_graph(self, conversation_id: int, db: Session) -> dict:
        """Return a topic graph for the conversation, building + caching
        on cache miss. Cache is keyed by message count: a new turn arrives,
        cache invalidates, next read regenerates. Empty/malformed cache
        treated as miss.
        """
        conv = (
            db.query(Conversation).filter(Conversation.id == conversation_id).first()
        )
        if not conv:
            return {"nodes": [], "edges": []}
        msgs = self.get_messages(conversation_id, db)
        current_count = len(msgs)

        if conv.topic_graph:
            try:
                cached = json.loads(conv.topic_graph)
                if cached.get("message_count") == current_count:
                    return {
                        "nodes": cached.get("nodes") or [],
                        "edges": cached.get("edges") or [],
                    }
            except json.JSONDecodeError:
                pass  # fall through and regenerate

        graph = _build_topic_graph_via_llm(msgs) or {"nodes": [], "edges": []}
        payload = {
            "message_count": current_count,
            "nodes": graph["nodes"],
            "edges": graph["edges"],
        }
        conv.topic_graph = json.dumps(payload)
        db.commit()
        return {"nodes": graph["nodes"], "edges": graph["edges"]}

    def maybe_summarize(self, conversation_id: int, db: Session) -> str | None:
        """Regenerate the rolling summary on every SUMMARIZE_EVERY_N messages.
        No-op otherwise. Runs after the assistant reply, so latency is hidden
        from the user. Returns the new summary if generated, else None.
        """
        msgs = self.get_messages(conversation_id, db)
        n = len(msgs)
        if n == 0 or n % SUMMARIZE_EVERY_N != 0:
            return None
        summary = _build_summary_via_llm(msgs)
        if not summary:
            return None
        conv = (
            db.query(Conversation).filter(Conversation.id == conversation_id).first()
        )
        if not conv:
            return None
        conv.summary = summary
        db.commit()
        return summary

    def get_last_assistant_message(
        self, conversation_id: int, db: Session
    ) -> Message | None:
        """Most recent assistant Message in this conversation, or None."""
        return (
            db.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.role == "assistant",
            )
            .order_by(Message.id.desc())
            .first()
        )

    def get_recent_messages(
        self, conversation_id: int, limit: int, db: Session
    ) -> list[Message]:
        """Most recent N messages for LLM context window (returned oldest-first)."""
        rows = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
            .all()
        )
        return list(reversed(rows))


conversation_service = ConversationService()
