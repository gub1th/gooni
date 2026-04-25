from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .list_tools import AddToListTool, ShowListTool
from .focus_tools import MarkFocusActivityTool

registry = [
    SaveMemoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
    AddToListTool(),
    ShowListTool(),
    MarkFocusActivityTool(),
]
tool_map = {t.name: t for t in registry}
