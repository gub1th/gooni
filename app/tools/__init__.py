from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .list_tools import AddToListTool, ShowListTool
from .focus_tools import MarkFocusActivityTool
from .note_tools import SearchNotesTool
from .feature_request_tool import RequestFeatureTool

registry = [
    SaveMemoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
    AddToListTool(),
    ShowListTool(),
    MarkFocusActivityTool(),
    SearchNotesTool(),
    RequestFeatureTool(),
]
tool_map = {t.name: t for t in registry}
