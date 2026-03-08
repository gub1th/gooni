import json
import urllib.parse
import urllib.request

from .base import BaseTool


class WebSearchTool(BaseTool):
    name = "web_search"
    description = (
        "Search the web for current information. "
        "Use this when the user asks about recent events, statistics, or anything "
        "that might be outside your training data."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query",
            },
        },
        "required": ["query"],
    }

    def execute(self, query: str = "", db=None, **kwargs) -> str:
        try:
            encoded = urllib.parse.quote_plus(query)
            url = f"https://ddg-api.herokuapp.com/search?query={encoded}&limit=5"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                results = json.loads(resp.read().decode("utf-8"))
            if not results:
                return "No results found."
            lines = []
            for r in results:
                lines.append(f"- {r.get('title', '')}: {r.get('snippet', '')} ({r.get('link', '')})")
            return "\n".join(lines)
        except Exception as e:
            return f"Search failed: {e}"
