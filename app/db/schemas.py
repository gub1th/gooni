from typing import Optional

from pydantic import BaseModel


class ChatRequest(BaseModel):
    content: str
    image_url: Optional[str] = None
