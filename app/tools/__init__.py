from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .note_tools import (
    SearchNotesTool,
    AddNoteTool,
    FindNoteTool,
    ReadNoteTool,
    ListRecentNotesTool,
)
from .promise_tools import ListPromisesTool
from .trackable_tools import ReadTrackableTool
from .feature_request_tool import RequestFeatureTool
from .calendar_tools import (
    CreateCalendarEventTool,
    CheckCalendarFreeBusyTool,
    ListUpcomingEventsTool,
    UpdateCalendarEventTool,
    DeleteCalendarEventTool,
)

# Slice 6 registry — post primitive-collapse chat surface. Writes for the
# actionable primitives are router-driven (promise glow/complete, fitness
# entries), so the tool surface is mostly recall + notes + calendar.
registry = [
    # Memory
    SaveMemoryTool(),
    # Web
    FetchUrlTool(),
    WebSearchTool(),
    # Notes
    SearchNotesTool(),
    AddNoteTool(),
    FindNoteTool(),
    ReadNoteTool(),
    ListRecentNotesTool(),
    # Promises + trackables (read-only — router owns the writes)
    ListPromisesTool(),
    ReadTrackableTool(),
    # Feature requests (tagged Notes since Slice 6)
    RequestFeatureTool(),
    # Calendar
    CreateCalendarEventTool(),
    CheckCalendarFreeBusyTool(),
    ListUpcomingEventsTool(),
    UpdateCalendarEventTool(),
    DeleteCalendarEventTool(),
]
tool_map = {t.name: t for t in registry}
