from .web_search import WebSearchTool
from .fetch_url import FetchUrlTool
from .todo_tools import TodoAddTool, TodoListTool, TodoCompleteTool, TodoDeleteTool

registry = [
    WebSearchTool(),
    FetchUrlTool(),
    TodoAddTool(),
    TodoListTool(),
    TodoCompleteTool(),
    TodoDeleteTool(),
]
tool_map = {t.name: t for t in registry}
