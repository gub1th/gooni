from abc import ABC, abstractmethod


class BaseTool(ABC):
    name: str
    description: str
    parameters: dict  # JSON Schema for the tool's arguments

    @abstractmethod
    def execute(self, db=None, **kwargs) -> str:
        """Run the tool and return a string result.
        db is injected for tools that need database access; ignore it if not needed.
        """
        ...

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
