"""Application configuration loaded from environment variables."""
import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    # LiteLLM / Hyperspace proxy
    LITELLM_PROXY_URL: str = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000").rstrip("/")
    LITELLM_API_KEY: str = os.getenv("LITELLM_API_KEY", "")

    DEFAULT_MODEL: str = os.getenv("DEFAULT_MODEL", "gpt-4o")
    AVAILABLE_MODELS: list[str] = [
        m.strip()
        for m in os.getenv(
            "AVAILABLE_MODELS", "gpt-4o,gpt-4o-mini,claude-3-5-sonnet,gemini-1.5-pro"
        ).split(",")
        if m.strip()
    ]

    # Server
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    CORS_ORIGINS: list[str] = [
        o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
    ]

    SYSTEM_PROMPT: str = os.getenv(
        "SYSTEM_PROMPT",
        "You are a helpful, knowledgeable AI assistant. Answer clearly and concisely.",
    )

    # Max upload size per file, in megabytes.
    MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "100"))

    @property
    def MAX_UPLOAD_BYTES(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024


settings = Settings()