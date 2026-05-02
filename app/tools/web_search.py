import json
import os
import urllib.error
import urllib.request

from .base import BaseTool


# Tavily is a search API purpose-built for LLM agents — returns clean,
# snippet-shaped JSON without the bot-detection wars that hit DuckDuckGo
# scraping. Free tier covers 1000 calls/month. Set TAVILY_API_KEY in .env.
# If the key is missing, the tool returns a clear "not configured" message
# so the model can refuse honestly instead of fabricating an answer.
_TAVILY_ENDPOINT = "https://api.tavily.com/search"


class WebSearchTool(BaseTool):
    name = "web_search"
    description = (
        "Search the web for current information — weather, news, sports "
        "scores, prices, recent events, anything time-sensitive or outside "
        "your training data. Returns ranked snippets with source URLs."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to search for. Be specific.",
            },
        },
        "required": ["query"],
    }

    def execute(self, query: str = "", db=None, **kwargs) -> str:
        if not query or not query.strip():
            return "web_search: empty query."
        api_key = os.getenv("TAVILY_API_KEY", "").strip()
        if not api_key:
            return (
                "web_search: not configured (TAVILY_API_KEY missing). "
                "Tell Daniel to add it to .env."
            )
        payload = json.dumps({
            "api_key": api_key,
            "query": query,
            "search_depth": "basic",
            "max_results": 5,
            "include_answer": True,
        }).encode("utf-8")
        req = urllib.request.Request(
            _TAVILY_ENDPOINT,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return f"web_search HTTP {e.code}: {e.reason}"
        except urllib.error.URLError as e:
            return f"web_search network error: {e.reason}"
        except Exception as e:
            return f"web_search failed: {e}"

        results = data.get("results") or []
        if not results:
            return "No results."
        # Tavily's `answer` field is a synthesized one-liner — useful header.
        lines: list[str] = []
        answer = (data.get("answer") or "").strip()
        if answer:
            lines.append(f"Answer: {answer}")
            lines.append("")
        for r in results[:5]:
            title = r.get("title", "").strip()
            content = (r.get("content") or "").strip().replace("\n", " ")
            if len(content) > 240:
                content = content[:240] + "…"
            url = r.get("url", "")
            lines.append(f"- {title}: {content} ({url})")
        return "\n".join(lines)
