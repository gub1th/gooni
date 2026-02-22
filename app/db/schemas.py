from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ConversationCreate(BaseModel):
    title: Optional[str] = None


class ConversationResponse(BaseModel):
    id: int
    title: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class InteractionCreate(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    conversation_id: Optional[int] = None


class InteractionResponse(BaseModel):
    id: int
    role: str
    content: str
    conversation_id: int
    timestamp: datetime

    class Config:
        from_attributes = True


class MemoryCreate(BaseModel):
    content: str
    embedding: Optional[str] = None
    metadata: Optional[str] = None


class MemoryResponse(BaseModel):
    id: int
    content: str
    embedding: Optional[str]
    metadata: Optional[str]
    timestamp: datetime

    class Config:
        from_attributes = True
