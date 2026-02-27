from abc import ABC, abstractmethod


class BaseTool(ABC):
    name: str
    description: str
    parameters: dict  # JSON Schema for the tool's arguments

    @abstractmethod
    def execute(self, **kwargs) -> str:
        """Run the tool and return a string result."""
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
