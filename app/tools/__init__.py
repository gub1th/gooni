from .goal_tools import GetGoalsTool, CreateGoalTool, LogProgressTool
from .memory_tools import SaveMemoryTool
from .fitness_tools import (
    LogMealTool,
    GetDailyMacrosTool,
    LogWorkoutTool,
    GetExerciseHistoryTool,
)

registry = [
    GetGoalsTool(),
    CreateGoalTool(),
    LogProgressTool(),
    SaveMemoryTool(),
    LogMealTool(),
    GetDailyMacrosTool(),
    LogWorkoutTool(),
    GetExerciseHistoryTool(),
]
tool_map = {t.name: t for t in registry}
