import urllib.request

from .base import BaseTool


class FetchUrlTool(BaseTool):
    name = "fetch_url"
    description = (
        "Fetch the content of a URL and return it as text. "
        "Use this to read articles, documentation, or any web page the user references."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to fetch",
            },
        },
        "required": ["url"],
    }

    def execute(self, url: str = "", db=None, **kwargs) -> str:
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                content = resp.read().decode("utf-8", errors="replace")
            # Trim to avoid flooding the context window
            return content[:8000] if len(content) > 8000 else content
        except Exception as e:
            return f"Failed to fetch {url}: {e}"
