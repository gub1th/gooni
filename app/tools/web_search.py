from .base import BaseTool


class WebSearchTool(BaseTool):
    name = "web_search"
    description = (
        "Search the web for current information. Use this for recent events, "
        "news, prices, or anything that may have changed since your training cutoff."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query",
            }
        },
        "required": ["query"],
    }

    def execute(self, query: str) -> str:
        try:
            from ddgs import DDGS

            results = DDGS().text(query, max_results=5)
            if not results:
                return "No results found."

            formatted = []
            for r in results:
                formatted.append(f"**{r['title']}**\n{r['body']}\nURL: {r['href']}")
            return "\n\n".join(formatted)
        except Exception as e:
            return f"Search failed: {e}"
