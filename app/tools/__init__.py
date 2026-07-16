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
from .trackable_tools import ReadTrackableTool, LogTrackableEntryTool
from .feature_request_tool import RequestFeatureTool
from .calendar_tools import (
    CreateCalendarEventTool,
    CheckCalendarFreeBusyTool,
    ListUpcomingEventsTool,
    UpdateCalendarEventTool,
    DeleteCalendarEventTool,
)

# Slice 6 registry — post primitive-collapse chat surface. Promise writes are
# router-driven (glow/complete); trackable logging is an explicit tool
# (log_trackable_entry) since the fitness-intent auto-writer was cut. Rest is
# recall + notes + calendar.
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
    # Promises (read-only — router owns the writes) + trackables (read + explicit log)
    ListPromisesTool(),
    ReadTrackableTool(),
    LogTrackableEntryTool(),
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
