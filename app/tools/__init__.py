from .goal_tools import GetGoalsTool, CreateGoalTool
from .memory_tools import SaveMemoryTool
from .fitness_tools import (
    LogMealTool,
    GetDailyMacrosTool,
    LogWorkoutTool,
    GetExerciseHistoryTool,
)
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool

registry = [
    GetGoalsTool(),
    CreateGoalTool(),
    SaveMemoryTool(),
    LogMealTool(),
    GetDailyMacrosTool(),
    LogWorkoutTool(),
    GetExerciseHistoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
]
tool_map = {t.name: t for t in registry}
