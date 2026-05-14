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
from .todo_tools import AddTodoTool, ListTodosTool, SetTodoStateTool
from .focus_tools import AddFocusTool, ListFocusesTool
from .habit_tools import LogHabitTool
from .feature_request_tool import RequestFeatureTool
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
    # Focuses
    AddFocusTool(),
    ListFocusesTool(),
    # Habits
    LogHabitTool(),
    # Feature requests + calendar
    RequestFeatureTool(),
    CreateCalendarEventTool(),
    CheckCalendarFreeBusyTool(),
    ListUpcomingEventsTool(),
    UpdateCalendarEventTool(),
    DeleteCalendarEventTool(),
]
tool_map = {t.name: t for t in registry}
