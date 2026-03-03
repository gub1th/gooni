from .goal_tools import GetGoalsTool, CreateGoalTool, LogProgressTool
from .memory_tools import SaveMemoryTool

registry = [
    GetGoalsTool(),
    CreateGoalTool(),
    LogProgressTool(),
    SaveMemoryTool(),
]
tool_map = {t.name: t for t in registry}
