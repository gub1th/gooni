from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .list_tools import AddToListTool, ShowListTool, CheckListItemTool
from .note_tools import (
    SearchNotesTool,
    AddNoteTool,
    FindNoteTool,
    ReadNoteTool,
    ListRecentNotesTool,
)
from .todo_tools import (
    AddTodoTool,
    ListTodosTool,
    SetTodoStateTool,
    GroomTodosTool,
    MergeTodosTool,
    RenameTodoTool,
    UndoLastTodoOpTool,
    ShowMyPlateTool,
    ShowChainTool,
)
from .focus_tools import AddFocusTool, ListFocusesTool
from .habit_tools import LogHabitTool
from .feature_request_tool import RequestFeatureTool
from .activity_tools import ReadRecentCommitsTool, ReadRecentBacklogTool
from .update_capability_tool import UpdateCapabilityFacetTool
from .calendar_tools import (
    CreateCalendarEventTool,
    CheckCalendarFreeBusyTool,
    ListUpcomingEventsTool,
    UpdateCalendarEventTool,
    DeleteCalendarEventTool,
)

registry = [
    # Memory
    SaveMemoryTool(),
    # Web
    FetchUrlTool(),
    WebSearchTool(),
    # Lists (generic)
    AddToListTool(),
    ShowListTool(),
    CheckListItemTool(),
    # Notes
    SearchNotesTool(),
    AddNoteTool(),
    FindNoteTool(),
    ReadNoteTool(),
    ListRecentNotesTool(),
    # Todos (dashboard)
    AddTodoTool(),
    ListTodosTool(),
    SetTodoStateTool(),
    # Todo grooming (G1 — auto-act + 24h soft-delete undo)
    GroomTodosTool(),
    MergeTodosTool(),
    RenameTodoTool(),
    UndoLastTodoOpTool(),
    # G3.9 recall fluency — explicit tools for "what's primary"/"chain of X"
    ShowMyPlateTool(),
    ShowChainTool(),
    # Focuses
    AddFocusTool(),
    ListFocusesTool(),
    # Habits
    LogHabitTool(),
    # Feature requests + calendar
    RequestFeatureTool(),
    # Recent activity (read-only)
    ReadRecentCommitsTool(),
    ReadRecentBacklogTool(),
    # Self-improvement
    UpdateCapabilityFacetTool(),
    CreateCalendarEventTool(),
    CheckCalendarFreeBusyTool(),
    ListUpcomingEventsTool(),
    UpdateCalendarEventTool(),
    DeleteCalendarEventTool(),
]
tool_map = {t.name: t for t in registry}
