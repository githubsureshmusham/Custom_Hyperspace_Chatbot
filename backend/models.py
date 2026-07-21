"""Pydantic request/response schemas."""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[Message] = Field(..., description="Conversation history")
    model: Optional[str] = Field(None, description="Model to use; falls back to default")
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, ge=1)
    stream: bool = Field(True, description="Whether to stream the response")
    system_prompt: Optional[str] = Field(None, description="Override the system prompt")


class ChatResponse(BaseModel):
    content: str
    model: str


class ModelInfo(BaseModel):
    id: str
    name: str


class ModelsResponse(BaseModel):
    default: str
    models: list[ModelInfo]