from datetime import datetime
from typing import Optional

from pydantic import BaseModel

class InteractionCreate(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class InteractionResponse(BaseModel):
    id: int
    role: str
    content: str
    timestamp: datetime

    class Config:
        from_attributes = True


class MemoryCreate(BaseModel):
    content: str
    metadata: Optional[str] = None


class MemoryResponse(BaseModel):
    id: int
    content: str
    embedding: Optional[str]
    metadata: Optional[str]
    timestamp: datetime

    class Config:
        from_attributes = True
