from ..db.models import Todo


class TodoService:
    def create(self, content: str, db) -> Todo:
        todo = Todo(content=content)
        db.add(todo)
        db.commit()
        db.refresh(todo)
        return todo

    def list_open(self, db) -> list:
        return db.query(Todo).filter(Todo.is_done == False).order_by(Todo.created_at).all()

    def list_all(self, db) -> list:
        return db.query(Todo).order_by(Todo.created_at).all()

    def complete(self, todo_id: int, db) -> Todo | None:
        todo = db.query(Todo).filter(Todo.id == todo_id).first()
        if todo:
            todo.is_done = True
            db.commit()
            db.refresh(todo)
        return todo

    def delete(self, todo_id: int, db) -> bool:
        todo = db.query(Todo).filter(Todo.id == todo_id).first()
        if todo:
            db.delete(todo)
            db.commit()
            return True
        return False


todo_service = TodoService()
