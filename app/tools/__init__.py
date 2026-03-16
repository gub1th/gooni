from .goal_tools import GetGoalsTool, CreateGoalTool
from .memory_tools import SaveMemoryTool
from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool

registry = [
    GetGoalsTool(),
    CreateGoalTool(),
    SaveMemoryTool(),
    FetchUrlTool(),
    WebSearchTool(),
]
tool_map = {t.name: t for t in registry}
