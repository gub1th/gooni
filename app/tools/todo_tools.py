from .base import BaseTool
from ..db.database import SessionLocal
from ..services.todo_service import todo_service


class TodoAddTool(BaseTool):
    name = "todo_add"
    description = "Add a new todo item to the user's list."
    parameters = {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The todo item description",
            }
        },
        "required": ["content"],
    }

    def execute(self, content: str) -> str:
        db = SessionLocal()
        try:
            todo = todo_service.create(content, db)
            return f"Added todo #{todo.id}: {todo.content}"
        finally:
            db.close()


class TodoListTool(BaseTool):
    name = "todo_list"
    description = "List all open (incomplete) todo items."
    parameters = {
        "type": "object",
        "properties": {},
        "required": [],
    }

    def execute(self) -> str:
        db = SessionLocal()
        try:
            todos = todo_service.list_open(db)
            if not todos:
                return "No open todos."
            lines = [f"#{t.id} {t.content}" for t in todos]
            return "Open todos:\n" + "\n".join(lines)
        finally:
            db.close()


class TodoCompleteTool(BaseTool):
    name = "todo_complete"
    description = "Mark a todo item as done by its ID."
    parameters = {
        "type": "object",
        "properties": {
            "todo_id": {
                "type": "integer",
                "description": "The ID of the todo to mark as complete",
            }
        },
        "required": ["todo_id"],
    }

    def execute(self, todo_id: int) -> str:
        db = SessionLocal()
        try:
            todo = todo_service.complete(todo_id, db)
            if todo:
                return f"Completed todo #{todo.id}: {todo.content}"
            return f"No todo found with ID {todo_id}."
        finally:
            db.close()


class TodoDeleteTool(BaseTool):
    name = "todo_delete"
    description = "Delete a todo item by its ID."
    parameters = {
        "type": "object",
        "properties": {
            "todo_id": {
                "type": "integer",
                "description": "The ID of the todo to delete",
            }
        },
        "required": ["todo_id"],
    }

    def execute(self, todo_id: int) -> str:
        db = SessionLocal()
        try:
            success = todo_service.delete(todo_id, db)
            if success:
                return f"Deleted todo #{todo_id}."
            return f"No todo found with ID {todo_id}."
        finally:
            db.close()
