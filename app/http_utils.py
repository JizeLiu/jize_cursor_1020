import json
from collections.abc import AsyncIterator

import httpx

from .config import ModelConfig


class ModelError(Exception):
    """调用用户部署的模型服务失败。message 会直接显示在界面上。"""


def openai_url(base_url: str, path: str) -> str:
    """拼 OpenAI 兼容接口地址：base_url 末尾带不带 /v1 都可以。"""
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/{path}"
    return f"{base}/v1/{path}"


def auth_headers(model: ModelConfig) -> dict[str, str]:
    return {"Authorization": f"Bearer {model.api_key}"} if model.api_key else {}


async def check_status(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    body = (await resp.aread()).decode(errors="ignore")[:400]
    raise ModelError(f"模型服务返回 {resp.status_code}：{body}")


async def iter_sse(resp: httpx.Response) -> AsyncIterator[str]:
    """逐条产出 SSE 里 `data: ...` 的内容（不含 [DONE]）。"""
    async for line in resp.aiter_lines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        if data:
            yield data


def parse_json(text: str) -> dict:
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        return {}


def connection_error(model: ModelConfig, e: Exception) -> ModelError:
    return ModelError(f"连接模型「{model.name}」失败（{model.base_url}）：{e}")
