from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .list_tools import AddToListTool, ShowListTool
from .note_tools import SearchNotesTool
from .feature_request_tool import RequestFeatureTool
from .calendar_tools import (
    CreateCalendarEventTool,
    CheckCalendarFreeBusyTool,
    ListUpcomingEventsTool,
    UpdateCalendarEventTool,
    DeleteCalendarEventTool,
)

registry = [
    SaveMemoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
    AddToListTool(),
    ShowListTool(),
    SearchNotesTool(),
    RequestFeatureTool(),
    CreateCalendarEventTool(),
    CheckCalendarFreeBusyTool(),
    ListUpcomingEventsTool(),
    UpdateCalendarEventTool(),
    DeleteCalendarEventTool(),
]
tool_map = {t.name: t for t in registry}
