from .web_search import WebSearchTool
from .fetch_url import FetchUrlTool

registry = [
    WebSearchTool(),
    FetchUrlTool(),
]
tool_map = {t.name: t for t in registry}
