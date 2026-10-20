"""调用对话大模型（vLLM 的 /v1/chat/completions），流式返回文字片段。通话功能用。"""

from collections.abc import AsyncIterator

import httpx

from .config import ModelConfig
from .http_utils import auth_headers, check_status, connection_error, iter_sse, openai_url, parse_json


async def stream_chat(model: ModelConfig, messages: list[dict]) -> AsyncIterator[str]:
    body = {"model": model.model, "messages": messages, "stream": True, **model.extra}
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", openai_url(model.base_url, "chat/completions"), json=body, headers=auth_headers(model)
            ) as resp:
                await check_status(resp)
                async for payload in iter_sse(resp):
                    delta = (parse_json(payload).get("choices") or [{}])[0].get("delta", {}).get("content")
                    if delta:
                        yield delta
    except httpx.HTTPError as e:
        raise connection_error(model, e) from e
