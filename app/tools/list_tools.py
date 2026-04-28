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
