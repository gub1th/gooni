from .base import BaseTool


class AddToListTool(BaseTool):
    name = "add_to_list"
    description = (
        "Add an item to one of the user's lists. "
        "Use the exact list name from the user's existing lists when possible."
    )
    parameters = {
        "type": "object",
        "properties": {
            "list_name": {
                "type": "string",
                "description": "The name of the list to add to",
            },
            "item": {
                "type": "string",
                "description": "The item to add",
            },
        },
        "required": ["list_name", "item"],
    }

    def execute(self, db=None, list_name: str = "", item: str = "", **kwargs) -> str:
        from ..services.list_service import list_service

        lst, _ = list_service.add_item_by_list_name(list_name, item, db)
        return f'Added "{item}" to {lst.name}.'


class ShowListTool(BaseTool):
    name = "show_list"
    description = "Show the items in one of the user's lists."
    parameters = {
        "type": "object",
        "properties": {
            "list_name": {
                "type": "string",
                "description": "The name of the list to show",
            },
        },
        "required": ["list_name"],
    }

    def execute(self, db=None, list_name: str = "", **kwargs) -> str:
        from ..services.list_service import list_service

        return list_service.show_list(list_name, db)


class CheckListItemTool(BaseTool):
    name = "check_list_item"
    description = (
        "Mark an item in one of Daniel's generic lists as done (or un-done) "
        "by substring match. For dashboard todos use set_todo_state instead "
        "— this is for items in user-created lists like 'groceries' or "
        "'reading'. Shortest-match wins."
    )
    parameters = {
        "type": "object",
        "properties": {
            "list_name": {
                "type": "string",
                "description": "Name of the list (must match an existing list).",
            },
            "match": {
                "type": "string",
                "description": "Case-insensitive substring of the item text.",
            },
            "done": {
                "type": "boolean",
                "description": "True to check, False to uncheck (default True).",
                "default": True,
            },
        },
        "required": ["list_name", "match"],
    }

    def execute(
        self,
        db=None,
        list_name: str = "",
        match: str = "",
        done: bool = True,
        **kwargs,
    ) -> str:
        from ..db.models import ListItem
        from ..services.list_service import list_service

        if db is None:
            return "(no db session)"
        lst = list_service.find_list_by_name(list_name, db)
        if lst is None:
            return f'(no list named "{list_name}")'
        match_l = (match or "").lower().strip()
        if not match_l:
            return "(empty match string)"
        items = (
            db.query(ListItem)
            .filter(ListItem.list_id == lst.id)
            .order_by(ListItem.sort_order, ListItem.id)
            .all()
        )
        # When checking, prefer open items; when unchecking, prefer done.
        candidates = [
            it for it in items
            if match_l in (it.text or "").lower()
            and (it.done is not bool(done))
        ]
        if not candidates:
            candidates = [it for it in items if match_l in (it.text or "").lower()]
        if not candidates:
            return f"(no item matching '{match}' in {lst.name})"
        candidates.sort(key=lambda it: len(it.text or ""))
        item = candidates[0]
        list_service.update_item(item.id, db, done=bool(done))
        mark = "[x]" if done else "[ ]"
        return f"{mark} {item.text} (in {lst.name})"
