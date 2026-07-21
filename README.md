# Nova AI — Custom AI Chatbot (ChatGPT/Gemini-style)

A full-stack, self-hosted AI chatbot with a modern ChatGPT/Gemini-style UI, powered by a **LiteLLM (Hyperspace) proxy**. Because the LiteLLM proxy exposes an **OpenAI-compatible API**, this app can talk to *any* model your proxy is configured for — OpenAI, Anthropic Claude, Google Gemini, Azure, local models, etc. — all through a single endpoint.

![architecture](https://img.shields.io/badge/backend-FastAPI-009688) ![litellm](https://img.shields.io/badge/proxy-LiteLLM-7c5cff) ![frontend](https://img.shields.io/badge/frontend-Vanilla_JS-f7df1e)

## ✨ Features

- 🎨 **Modern chat UI** — dark theme, streaming responses with a typing cursor, Markdown + code rendering
- ⚡ **Real-time streaming** via Server-Sent Events (SSE)
- 💬 **Multi-conversation** management with sidebar, persisted in `localStorage`
- 🔀 **Model selector** — switch between any models exposed by your proxy
- ⚙️ **Settings** — custom system prompt, temperature, max tokens
- 🔌 **LiteLLM Hyperspace proxy integration** — one API for many providers
- 🛑 **Stop generation** mid-stream
- 📱 **Responsive** — works on desktop and mobile

## 🏗️ Architecture

```
┌──────────────┐     HTTP/SSE      ┌──────────────┐   OpenAI-compatible   ┌─────────────────┐
│   Frontend   │ ───────────────►  │   FastAPI    │ ───────────────────►  │  LiteLLM /      │
│ (HTML/CSS/JS)│ ◄───────────────  │   Backend    │ ◄───────────────────  │  Hyperspace     │──► OpenAI / Claude
└──────────────┘   stream tokens   └──────────────┘    stream tokens      │  Proxy          │──► Gemini / Azure
                                                                            └─────────────────┘──► Local models
```

- **Frontend** (`frontend/`) — vanilla JS SPA served as static files.
- **Backend** (`backend/`) — FastAPI app that uses the `litellm` SDK pointed at your proxy's base URL. It normalizes requests, injects the system prompt, and streams tokens back as SSE.
- **LiteLLM proxy** — you run this separately (or use a hosted Hyperspace endpoint). It handles provider routing, keys, rate limits, and logging.

## 📁 Project structure

```
Custom AI Chatbot Tool/
├── backend/
│   ├── main.py            # FastAPI app + routes + static serving
│   ├── llm_service.py     # LiteLLM proxy calls (stream & complete)
│   ├── config.py          # Env-based settings
│   ├── models.py          # Pydantic schemas
│   ├── requirements.txt
│   └── .env.example       # Copy to .env and fill in your proxy details
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── run.bat                # One-click launcher (Windows)
├── .gitignore
└── README.md
```

## 🚀 Quick start

### Prerequisites
- Python 3.10+
- A running **LiteLLM proxy** (Hyperspace) URL and API key

### Option A — Windows one-click

```bat
run.bat
```

This creates a virtualenv, installs deps, copies `.env.example` → `.env`, and starts the server. **Edit `backend\.env` with your proxy details, then re-run.**

### Option B — Manual (any OS)

```bash
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
python -m pip install -r requirements.txt

cp .env.example .env        # then edit it (see below)
python main.py
```

Open **http://localhost:8000** in your browser.

## ⚙️ Configuration (`backend/.env`)

```env
# Base URL of your LiteLLM / Hyperspace proxy
LITELLM_PROXY_URL=https://your-hyperspace-proxy.example.com

# Virtual key issued by the proxy
LITELLM_API_KEY=sk-your-litellm-proxy-key

# Default model (must exist in your proxy config)
DEFAULT_MODEL=gpt-4o

# Models shown in the UI dropdown
AVAILABLE_MODELS=gpt-4o,gpt-4o-mini,claude-3-5-sonnet,gemini-1.5-pro

HOST=0.0.0.0
PORT=8000
CORS_ORIGINS=*
SYSTEM_PROMPT=You are a helpful, knowledgeable AI assistant.
```

> **How the proxy connection works:** The backend uses the `litellm` SDK with
> `api_base=LITELLM_PROXY_URL`, `api_key=LITELLM_API_KEY`, and
> `custom_llm_provider="openai"`. Since LiteLLM proxies are OpenAI-compatible,
> every request (regardless of the underlying provider) is sent to
> `{LITELLM_PROXY_URL}/chat/completions`.

## 🧪 Don't have a proxy yet? Run LiteLLM locally

You can spin up your own LiteLLM proxy in minutes:

```bash
pip install "litellm[proxy]"
```

Create `litellm_config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-3-5-sonnet
    litellm_params:
      model: anthropic/claude-3-5-sonnet-20241022
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: gemini-1.5-pro
    litellm_params:
      model: gemini/gemini-1.5-pro
      api_key: os.environ/GEMINI_API_KEY
```

Start the proxy:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...
litellm --config litellm_config.yaml --port 4000
```

Then set in `backend/.env`:

```env
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=sk-1234        # or whatever master/virtual key you configured
```

## 🔌 API reference

The backend exposes a small REST API (auto-docs at `http://localhost:8000/docs`).

### `GET /api/health`
Returns `{ "status": "ok", "proxy": "<proxy url>" }`.

### `GET /api/models`
```json
{
  "default": "gpt-4o",
  "models": [{ "id": "gpt-4o", "name": "gpt-4o" }, ...]
}
```

### `POST /api/chat`
Request body:
```json
{
  "messages": [{ "role": "user", "content": "Hello!" }],
  "model": "gpt-4o",
  "temperature": 0.7,
  "max_tokens": 1024,
  "system_prompt": "You are helpful.",
  "stream": true
}
```

- When `stream: true` → responds with `text/event-stream`. Each event is
  `data: {"token": "..."}`, ending with `data: {"done": true}`. Errors come as
  `data: {"error": "..."}`.
- When `stream: false` → responds with `{ "content": "...", "model": "..." }`.

## 🛠️ Tech stack

| Layer     | Tech                                   |
|-----------|----------------------------------------|
| Backend   | FastAPI, Uvicorn, LiteLLM SDK, Pydantic|
| Frontend  | Vanilla JS, marked.js, DOMPurify       |
| Transport | Server-Sent Events (SSE)               |
| Proxy     | LiteLLM / Hyperspace (OpenAI-compatible)|

## 🔒 Notes on security

- Never commit `backend/.env` (already in `.gitignore`).
- For production, restrict `CORS_ORIGINS` and put the app behind HTTPS.
- Conversations are stored client-side in `localStorage` — no server DB required. Add one if you need cross-device history.

## 🧩 Extending

- **Add auth**: put a dependency on the routes or a reverse-proxy in front.
- **Persist chats server-side**: swap `localStorage` logic for a `/api/conversations` CRUD backed by SQLite/Postgres.
- **File uploads / RAG**: add an endpoint that embeds documents and injects context before calling the proxy.
- **Usage/analytics**: LiteLLM proxy already logs spend & tokens per key.

## 📜 License

MIT — do whatever you like.
