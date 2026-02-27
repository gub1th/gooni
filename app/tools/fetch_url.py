from .base import BaseTool

MAX_CHARS = 5000


class FetchUrlTool(BaseTool):
    name = "fetch_url"
    description = (
        "Fetch and read the contents of a URL. Use this when the user provides "
        "a specific link or when you need the full content of a webpage."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to fetch",
            }
        },
        "required": ["url"],
    }

    def execute(self, url: str) -> str:
        try:
            import httpx

            response = httpx.get(url, follow_redirects=True, timeout=10)
            response.raise_for_status()

            content_type = response.headers.get("content-type", "")
            if "html" in content_type:
                return self._extract_text(response.text)
            return response.text[:MAX_CHARS]
        except Exception as e:
            return f"Failed to fetch URL: {e}"

    def _extract_text(self, html: str) -> str:
        try:
            from bs4 import BeautifulSoup

            soup = BeautifulSoup(html, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = soup.get_text(separator="\n", strip=True)
            lines = [line for line in text.splitlines() if line.strip()]
            return "\n".join(lines)[:MAX_CHARS]
        except Exception:
            return html[:MAX_CHARS]
