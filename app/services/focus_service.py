from ..llm.client import llm_client
from .memory_service import memory_service


class FocusService:
    def get_commentary(self, focuses: list) -> dict:
        """Batch 2-3 sentence commentary for committed+pending focuses.
        Returns {focus_id: commentary_text}."""
        if not focuses:
            return {}

        focus_list = "\n".join(
            f"{i+1}. [{f.commitment.upper()}] {f.name}"
            + (f" (due {f.due_date})" if f.due_date else "")
            for i, f in enumerate(focuses)
        )

        memory_parts = []
        for i, f in enumerate(focuses):
            results = memory_service.search(f.name, limit=3)
            snippet = "; ".join(r["memory"] for r in results[:3]) if results else "no relevant memories"
            memory_parts.append(f"{i+1}. {f.name}: {snippet}")
        memory_block = "\n".join(memory_parts)

        prompt = f"""You are Gooni — Daniel's fully loyal, slightly unhinged AI minion.
Write a 2-3 sentence commentary for each of Daniel's focuses below.
Reference what Daniel has actually said or done using the memory context. Be direct, personal, slightly confrontational — like you actually know him.
Don't be generic. Output exactly {len(focuses)} numbered lines. Each line is the full 2-3 sentence commentary for that focus.

Focuses:
{focus_list}

Memory context (per focus):
{memory_block}

Output (exactly {len(focuses)} numbered lines, nothing else):
1. <2-3 sentence commentary>
2. <2-3 sentence commentary>
..."""

        raw = llm_client.generate_simple_completion(prompt, max_tokens=600)
        lines = [l for l in raw.strip().split("\n") if l.strip()]
        result = {}
        for i, f in enumerate(focuses):
            if i < len(lines):
                commentary = lines[i].lstrip("0123456789. ").strip()
                result[f.id] = commentary
        return result

    def get_daily_briefing(self, focuses: list, overdue_names: list) -> str:
        """Generate Gooni's Take — a 2-3 sentence daily briefing paragraph."""
        if not focuses:
            return ""

        focus_lines = "\n".join(
            f"- [{f.commitment.upper()}] {f.name}"
            + (" ⚠️ OVERDUE" if f.name in overdue_names else "")
            + (f" (due {f.due_date})" if f.due_date else "")
            for f in focuses
        )

        mem_results = memory_service.search("Daniel goals priorities recent activity", limit=5)
        mem_context = (
            "\n".join(f"- {r['memory']}" for r in mem_results)
            if mem_results
            else "No memories yet."
        )

        prompt = f"""You are Gooni — Daniel's fully loyal, slightly unhinged AI minion.
Write a 2-3 sentence daily briefing paragraph for Daniel.
Reference his specific focuses by name, call out any overdue items directly, pull in relevant context from memory.
Be direct and personal — you know him well. Slightly confrontational in a caring way. No preamble, just the briefing.

His focuses:
{focus_lines}

Memory context:
{mem_context}

Write the briefing (2-3 sentences, no intro like "Here's your briefing:"):"""

        print("daily briefing prompt:", prompt)

        return llm_client.generate_simple_completion(prompt, max_tokens=150)


focus_service = FocusService()
