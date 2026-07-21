"""Custom AI Chatbot backend powered by the LiteLLM / Hyperspace proxy."""
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings
from models import ChatRequest, ChatResponse, ModelInfo, ModelsResponse
from llm_service import stream_chat, complete_chat

app = FastAPI(title="Custom AI Chatbot", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")


def _prepare_messages(req: ChatRequest) -> list[dict]:
    """Ensure a system prompt is present at the start of the conversation."""
    messages = [m.model_dump() for m in req.messages]
    has_system = any(m["role"] == "system" for m in messages)
    if not has_system:
        system = req.system_prompt or settings.SYSTEM_PROMPT
        messages.insert(0, {"role": "system", "content": system})
    return messages


@app.get("/api/health")
async def health():
    return {"status": "ok", "proxy": settings.LITELLM_PROXY_URL}


@app.get("/api/models", response_model=ModelsResponse)
async def list_models():
    models = [ModelInfo(id=m, name=m) for m in settings.AVAILABLE_MODELS]
    return ModelsResponse(default=settings.DEFAULT_MODEL, models=models)


@app.post("/api/chat")
async def chat(req: ChatRequest):
    model = req.model or settings.DEFAULT_MODEL
    messages = _prepare_messages(req)

    if req.stream:
        return StreamingResponse(
            stream_chat(messages, model, req.temperature, req.max_tokens),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        content = await complete_chat(messages, model, req.temperature, req.max_tokens)
        return ChatResponse(content=content, model=model)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


# ---- Serve the frontend ----
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn

    # Note: HOST=0.0.0.0 means "listen on all interfaces". In your browser you
    # must open http://localhost:PORT (0.0.0.0 is NOT a browsable address).
    browse_host = "localhost" if settings.HOST in ("0.0.0.0", "") else settings.HOST
    print("\n" + "=" * 60)
    print(f"  Nova AI is running!")
    print(f"  Open your browser at:  http://{browse_host}:{settings.PORT}")
    print("=" * 60 + "\n")

    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=True)
