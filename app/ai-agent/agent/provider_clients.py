from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TYPE_CHECKING

try:
    import httpx
except ImportError:  # pragma: no cover - dependency is required only for live provider calls.
    httpx = None  # type: ignore[assignment]

if TYPE_CHECKING:
    from .contracts import AiModelRequest


DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"


@dataclass(frozen=True)
class ProviderHttpRequest:
    url: str
    headers: dict[str, str]
    body: dict[str, Any]


def build_provider_request(model: "AiModelRequest", prompt: str) -> ProviderHttpRequest:
    api_key = (model.provider_key or "").strip()
    if not api_key:
        raise ValueError(f"{provider_label(model.provider)} API key chưa được đồng bộ về local.")

    if model.provider == "gemini":
        return ProviderHttpRequest(
            url=f"https://generativelanguage.googleapis.com/v1beta/models/{model.model}:generateContent?key={api_key}",
            headers={"Content-Type": "application/json"},
            body={
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}],
                    }
                ],
                "generationConfig": {
                    "responseMimeType": "application/json",
                },
            },
        )

    base_url = (model.base_url or (DEFAULT_DEEPSEEK_BASE_URL if model.provider == "deepseek" else DEFAULT_OPENAI_COMPATIBLE_BASE_URL)).rstrip("/")
    return ProviderHttpRequest(
        url=f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        body={
            "model": model.model,
            "messages": [
                {"role": "system", "content": "Bạn là agent phân tích dữ liệu dashboard. Luôn trả lời tiếng Việt."},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        },
    )


async def call_provider(model: "AiModelRequest", prompt: str, timeout_seconds: float = 45.0) -> dict[str, Any]:
    if httpx is None:
        raise RuntimeError("Python AI Agent chưa cài httpx. Chạy pip install -r app/ai-agent/requirements.txt.")
    request = build_provider_request(model, prompt)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(request.url, headers=request.headers, json=request.body)
    except httpx.TimeoutException as exc:
        raise RuntimeError(f"{provider_label(model.provider)} timeout khi gọi trực tiếp từ máy local.") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"{provider_label(model.provider)} lỗi mạng khi gọi trực tiếp từ máy local: {exc}") from exc

    if response.status_code in {429, 500, 502, 503, 504}:
        raise RuntimeError(f"{provider_label(model.provider)} đang quá tải hoặc lỗi tạm thời ({response.status_code}).")
    if response.status_code >= 400:
        raise RuntimeError(f"{provider_label(model.provider)} trả lỗi {response.status_code}: {response.text[:500]}")
    return response.json()


def provider_label(provider: str) -> str:
    if provider == "deepseek":
        return "DeepSeek"
    if provider == "openai-compatible":
        return "Qwen/OpenAI-compatible"
    return "Gemini"
