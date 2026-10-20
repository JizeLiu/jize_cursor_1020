"""调用 TTS 模型（vLLM-Omni 的 /v1/audio/speech），以 PCM 流的形式逐块返回。"""

from collections.abc import AsyncIterator

import httpx

from .config import ModelConfig
from .http_utils import auth_headers, check_status, connection_error, openai_url


async def stream_tts(
    model: ModelConfig, text: str, *, voice: str = "", speed: float = 1.0, stream: bool = True
) -> AsyncIterator[bytes]:
    """产出 16bit 单声道 PCM 字节块，采样率见 model.tts_sample_rate。

    stream=False 时不让模型流式输出（对比用）：数据会在模型生成完后一次性到达。
    """
    body: dict = {
        "input": text,
        "response_format": "pcm",
        "stream": stream,
    }
    if model.model:
        body["model"] = model.model
    if voice or model.default_voice:
        body["voice"] = voice or model.default_voice
    if speed and speed != 1:
        body["speed"] = speed
    body.update(model.extra)

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", openai_url(model.base_url, "audio/speech"), json=body, headers=auth_headers(model)
            ) as resp:
                await check_status(resp)
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
    except httpx.HTTPError as e:
        raise connection_error(model, e) from e
