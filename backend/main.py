"""Custom AI Chatbot backend powered by the LiteLLM / Hyperspace proxy."""
import os

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings
from models import ChatRequest, ChatResponse, ModelInfo, ModelsResponse
from llm_service import stream_chat, complete_chat, fetch_models
from file_service import extract_file

app = FastAPI(title="Custom AI Chatbot", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")


def _build_message_with_attachments(msg: dict) -> dict:
    """Convert a message's attachments into content the model can consume.

    - Text attachments are appended to the message text as clearly-labeled blocks.
    - Image attachments become OpenAI-style `image_url` content parts (for vision
      models). When images are present we switch `content` to the multi-part list
      format `[{type:"text",...}, {type:"image_url",...}]`.
    """
    attachments = msg.get("attachments") or []
    base_text = msg.get("content") or ""

    text_blocks = []
    image_parts = []
    for att in attachments:
        atype = att.get("type")
        fname = att.get("filename", "file")
        if atype == "text" and att.get("content"):
            text_blocks.append(
                f'\n\n----- Attached file: {fname} -----\n{att["content"]}\n----- End of {fname} -----'
            )
        elif atype == "image" and att.get("data_url"):
            image_parts.append(
                {"type": "image_url", "image_url": {"url": att["data_url"]}}
            )
        elif atype == "unsupported":
            text_blocks.append(
                f'\n\n[Attached file "{fname}" could not be read: {att.get("reason", "unsupported")}]'
            )

    combined_text = base_text + "".join(text_blocks)

    result = {"role": msg["role"]}
    if image_parts:
        # Multi-part content: text first, then images.
        parts = []
        if combined_text.strip():
            parts.append({"type": "text", "text": combined_text})
        parts.extend(image_parts)
        result["content"] = parts
    else:
        result["content"] = combined_text
    return result


def _prepare_messages(req: ChatRequest) -> list[dict]:
    """Ensure a system prompt is present and fold attachments into content."""
    messages = []
    for m in req.messages:
        d = m.model_dump()
        if d.get("attachments"):
            messages.append(_build_message_with_attachments(d))
        else:
            messages.append({"role": d["role"], "content": d.get("content") or ""})

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
    """Return the live list of models from the proxy.

    Tries the proxy's OpenAI-compatible `/models` endpoint first; if that fails
    (proxy unreachable, auth issue, etc.) it falls back to the AVAILABLE_MODELS
    configured in the environment.
    """
    source = "proxy"
    try:
        model_ids = await fetch_models()
    except Exception:  # noqa: BLE001
        model_ids = settings.AVAILABLE_MODELS
        source = "env-fallback"

    if not model_ids:
        model_ids = settings.AVAILABLE_MODELS
        source = "env-fallback"

    # Pick a sensible default: configured default if present in the list,
    # otherwise the first available model.
    default = (
        settings.DEFAULT_MODEL
        if settings.DEFAULT_MODEL in model_ids
        else (model_ids[0] if model_ids else settings.DEFAULT_MODEL)
    )

    models = [ModelInfo(id=m, name=m) for m in model_ids]
    return ModelsResponse(default=default, models=models, source=source)


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


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """Accept a file (up to MAX_UPLOAD_MB), extract its content, and return an
    attachment object the frontend attaches to the next chat message."""
    data = await file.read()
    if len(data) > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max allowed size is {settings.MAX_UPLOAD_MB} MB.",
        )
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")

    try:
        result = extract_file(file.filename or "file", data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Failed to process file: {exc}")

    result["size"] = len(data)
    return result


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
