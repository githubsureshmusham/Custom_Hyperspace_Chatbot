"""Service layer that communicates with the LiteLLM / Hyperspace proxy.

The LiteLLM proxy exposes an OpenAI-compatible API, so we point the
`litellm` SDK at the proxy's base URL and use the issued virtual key.
"""
import json
from typing import AsyncGenerator

import httpx
import litellm
from litellm import acompletion

from config import settings

# Route all requests through the proxy. Because the proxy is OpenAI-compatible
# we set a custom api_base and api_key. `custom_llm_provider="openai"` forces
# litellm to use the OpenAI transport against the proxy URL.
litellm.drop_params = True  # silently drop params a given model doesn't support


# Substrings that indicate a parameter isn't supported by the target model.
# When we see these, we strip the offending param and retry once.
_UNSUPPORTED_PARAM_HINTS = {
    "temperature": ("temperature", "temperature` is deprecated", "does not support temperature"),
    "max_tokens": ("max_tokens", "max_completion_tokens"),
    "top_p": ("top_p",),
}


def _build_kwargs(model: str, messages: list[dict], temperature: float | None,
                  max_tokens: int | None, stream: bool) -> dict:
    kwargs: dict = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "api_base": settings.LITELLM_PROXY_URL,
        "api_key": settings.LITELLM_API_KEY,
        "custom_llm_provider": "openai",
    }
    # Only send temperature if provided (some models reject/deprecate it).
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens:
        kwargs["max_tokens"] = max_tokens
    return kwargs


def _param_to_drop(error_text: str) -> str | None:
    """Given an error message, decide which param to strip and retry without."""
    lowered = error_text.lower()
    for param, hints in _UNSUPPORTED_PARAM_HINTS.items():
        if any(h.lower() in lowered for h in hints):
            return param
    return None


async def _acompletion_with_retry(kwargs: dict):
    """Call the proxy, retrying without params the model rejects (e.g. temperature)."""
    attempt = 0
    while True:
        try:
            return await acompletion(**kwargs)
        except Exception as exc:  # noqa: BLE001
            attempt += 1
            drop = _param_to_drop(str(exc))
            if drop and drop in kwargs and attempt <= 3:
                kwargs.pop(drop, None)
                continue
            raise


async def stream_chat(
    messages: list[dict],
    model: str,
    temperature: float | None = 0.7,
    max_tokens: int | None = None,
) -> AsyncGenerator[str, None]:
    """Yield Server-Sent-Events style chunks of the assistant's reply."""
    kwargs = _build_kwargs(model, messages, temperature, max_tokens, stream=True)
    try:
        response = await _acompletion_with_retry(kwargs)
        async for chunk in response:
            try:
                delta = chunk.choices[0].delta
                token = getattr(delta, "content", None)
            except (AttributeError, IndexError):
                token = None
            if token:
                yield f"data: {json.dumps({'token': token})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
    except Exception as exc:  # noqa: BLE001
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"


async def complete_chat(
    messages: list[dict],
    model: str,
    temperature: float | None = 0.7,
    max_tokens: int | None = None,
) -> str:
    """Return the full assistant reply (non-streaming)."""
    kwargs = _build_kwargs(model, messages, temperature, max_tokens, stream=False)
    response = await _acompletion_with_retry(kwargs)
    return response.choices[0].message.content or ""


async def fetch_models() -> list[str]:
    """Retrieve the live list of model IDs from the LiteLLM / Hyperspace proxy.

    LiteLLM proxies are OpenAI-compatible and expose `GET {base}/models`, which
    returns `{"data": [{"id": "gpt-4o", ...}, ...]}`. We try the configured base
    URL as-is first, and also a "/v1"-adjusted variant, to be robust to how the
    proxy path is set up.
    """
    base = settings.LITELLM_PROXY_URL.rstrip("/")
    headers = {}
    if settings.LITELLM_API_KEY:
        headers["Authorization"] = f"Bearer {settings.LITELLM_API_KEY}"

    # Candidate endpoints to try (dedup while preserving order).
    candidates: list[str] = []
    for url in (f"{base}/models", f"{base}/v1/models"):
        if url not in candidates:
            candidates.append(url)

    async with httpx.AsyncClient(timeout=15.0) as client:
        last_error: Exception | None = None
        for url in candidates:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                payload = resp.json()
                data = payload.get("data", payload) if isinstance(payload, dict) else payload
                ids: list[str] = []
                for item in data or []:
                    if isinstance(item, dict):
                        mid = item.get("id") or item.get("model_name") or item.get("name")
                    else:
                        mid = str(item)
                    if mid and mid not in ids:
                        ids.append(mid)
                if ids:
                    return sorted(ids, key=str.lower)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                continue

    # If the proxy didn't return anything usable, raise so the caller can fall back.
    raise RuntimeError(
        f"Could not fetch models from proxy ({', '.join(candidates)}): {last_error}"
    )
