"""Pydantic request/response schemas."""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class Attachment(BaseModel):
    """A file the user attached to a message.

    - type "text": `content` holds the extracted text.
    - type "image": `data_url` holds a base64 data URL for vision models.
    """
    type: Literal["text", "image", "unsupported"]
    filename: str
    content: Optional[str] = None
    data_url: Optional[str] = None
    reason: Optional[str] = None


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str
    attachments: Optional[list[Attachment]] = None


class ChatRequest(BaseModel):
    messages: list[Message] = Field(..., description="Conversation history")
    model: Optional[str] = Field(None, description="Model to use; falls back to default")
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
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
    source: str = "proxy"  # "proxy" if fetched live, "env-fallback" otherwise
