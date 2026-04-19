from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .list_tools import AddToListTool, ShowListTool

registry = [
    SaveMemoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
    AddToListTool(),
    ShowListTool(),
]
tool_map = {t.name: t for t in registry}
