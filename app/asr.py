"""调用 ASR 模型。两种协议：

1. openai_transcriptions（vLLM）：整段音频 POST 上去，可选 SSE 流式返回文字。
2. funasr_ws（FunASR）：WebSocket，边推音频边返回结果，支持 online / 2pass / offline。

所有函数都是 async 生成器，不断产出 AsrUpdate：
    AsrUpdate(text="目前为止的完整文字", final=False)  # 中间结果
    AsrUpdate(text="完整文字", final=True)             # 最终结果
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx
import websockets

from .audio import SAMPLE_RATE, pcm_to_wav
from .config import Hotword, ModelConfig
from .hotwords import funasr_param, http_form_fields
from .http_utils import auth_headers, check_status, connection_error, iter_sse, openai_url, parse_json


@dataclass
class AsrUpdate:
    text: str
    final: bool = False
    segments: list[dict] = field(default_factory=list)  # [{text, start, end, spk}]


# ---------------------------------------------------------------- vLLM / OpenAI 协议


async def transcribe_http(
    model: ModelConfig,
    audio: bytes,
    filename: str,
    content_type: str,
    *,
    hotwords: list[Hotword],
    language: str = "",
    stream: bool = False,
) -> AsyncIterator[AsrUpdate]:
    data: dict[str, str] = {}
    if model.model:
        data["model"] = model.model
    if language:
        data["language"] = language
    data.update(http_form_fields(model, hotwords))
    for k, v in model.extra.items():
        data[k] = v if isinstance(v, str) else json.dumps(v)
    want_stream = stream and model.streaming
    if want_stream:
        data["stream"] = "true"

    url = openai_url(model.base_url, "audio/transcriptions")
    files = {"file": (filename, audio, content_type)}
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            if not want_stream:
                resp = await client.post(url, data=data, files=files, headers=auth_headers(model))
                await check_status(resp)
                body = resp.json()
                text = body.get("text") or body.get("choices", [{}])[0].get("message", {}).get("content", "")
                segments = [
                    {"text": s.get("text", ""), "start": s.get("start"), "end": s.get("end"), "spk": s.get("spk")}
                    for s in body.get("segments") or []
                ]
                yield AsrUpdate(text, final=True, segments=segments)
                return

            text = ""
            async with client.stream("POST", url, data=data, files=files, headers=auth_headers(model)) as resp:
                await check_status(resp)
                async for payload in iter_sse(resp):
                    obj = parse_json(payload)
                    # vLLM: choices[0].delta.content    OpenAI: type=transcript.text.delta / .done
                    delta = (obj.get("choices") or [{}])[0].get("delta", {}).get("content")
                    if delta:
                        text += delta
                        yield AsrUpdate(text)
                    elif obj.get("type") == "transcript.text.delta" and obj.get("delta"):
                        text += obj["delta"]
                        yield AsrUpdate(text)
                    elif obj.get("type") == "transcript.text.done" and obj.get("text"):
                        text = obj["text"]
            yield AsrUpdate(text, final=True)
    except httpx.HTTPError as e:
        raise connection_error(model, e) from e


# ---------------------------------------------------------------- FunASR WebSocket 协议


def _funasr_segments(stamp_sents: object) -> list[dict]:
    if not isinstance(stamp_sents, list):
        return []
    out = []
    for s in stamp_sents:
        out.append(
            {
                "text": s.get("text_seg") or s.get("text", ""),
                "start": s["start"] / 1000 if isinstance(s.get("start"), (int, float)) else None,
                "end": s["end"] / 1000 if isinstance(s.get("end"), (int, float)) else None,
                "spk": s.get("spk"),
            }
        )
    return out


async def transcribe_funasr(
    model: ModelConfig,
    pcm_chunks: AsyncIterator[bytes],
    *,
    hotwords: list[Hotword],
    mode: str | None = None,
) -> AsyncIterator[AsrUpdate]:
    """pcm_chunks 持续产出 16k PCM，产出完毕即视为说话结束。

    2pass 模式下：*-online 是实时草稿，*-offline 是句子结束后纠正过的最终文字，到达后替换草稿。
    """
    mode = mode or model.funasr_mode
    config = {
        "mode": mode,
        "chunk_size": [5, 10, 5],
        "chunk_interval": 10,
        "wav_name": f"web-{int(time.time())}",
        "is_speaking": True,
        "wav_format": "pcm",
        "audio_fs": SAMPLE_RATE,
        "hotwords": funasr_param(model, hotwords),
        "itn": True,
        **model.extra,
    }
    try:
        ws = await websockets.connect(model.base_url, additional_headers=auth_headers(model), max_size=None)
    except (OSError, websockets.WebSocketException) as e:
        raise connection_error(model, e) from e

    committed, partial = "", ""
    segments: list[dict] = []

    async def send_audio() -> None:
        async for chunk in pcm_chunks:
            await ws.send(chunk)
        await ws.send(json.dumps({"is_speaking": False}))

    sender = asyncio.create_task(send_audio())
    try:
        await ws.send(json.dumps(config))
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=15 if sender.done() else None)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                break
            msg = parse_json(raw if isinstance(raw, str) else "")
            text = msg.get("text", "")
            kind = msg.get("mode", mode)
            if kind in ("2pass-online", "online"):
                partial += text
            elif kind in ("2pass-offline", "offline"):
                committed += text
                partial = ""
                segments += _funasr_segments(msg.get("stamp_sents"))
            yield AsrUpdate(committed + partial)
            if msg.get("is_final") and sender.done():
                break
        if sender.done() and not sender.cancelled() and sender.exception():
            raise sender.exception()  # type: ignore[misc]
    finally:
        sender.cancel()
        await ws.close()
    yield AsrUpdate(committed + partial, final=True, segments=segments)


async def _chunks(pcm: bytes, step: int = 960 * 4) -> AsyncIterator[bytes]:
    """把整段 PCM 切成小包喂给 FunASR（每包 240ms）。"""
    for i in range(0, len(pcm), step):
        yield pcm[i : i + step]
        if (i // step) % 20 == 19:
            await asyncio.sleep(0.005)


# ---------------------------------------------------------------- 统一入口


async def transcribe_pcm(
    model: ModelConfig, pcm: bytes, *, hotwords: list[Hotword], language: str = "", stream: bool = False
) -> AsyncIterator[AsrUpdate]:
    """识别一整段 16k PCM（整段录音、VAD 切出来的语音段）。"""
    if model.protocol == "funasr_ws":
        mode = model.funasr_mode if stream else "offline"
        async for u in transcribe_funasr(model, _chunks(pcm), hotwords=hotwords, mode=mode):
            yield u
    else:
        async for u in transcribe_http(
            model, pcm_to_wav(pcm), "audio.wav", "audio/wav", hotwords=hotwords, language=language, stream=stream
        ):
            yield u


async def transcribe_text(model: ModelConfig, pcm: bytes, *, hotwords: list[Hotword], language: str = "") -> str:
    """只要最终文字（唤醒、通话用）。"""
    text = ""
    async for u in transcribe_pcm(model, pcm, hotwords=hotwords, language=language):
        text = u.text
    return text.strip()


async def asr_events(updates: AsyncIterator[AsrUpdate], audio_sec: float) -> AsyncIterator[dict]:
    """把 AsrUpdate 转成给浏览器的事件，并附上延迟指标。"""
    t0 = time.perf_counter()
    first_token_ms: float | None = None
    async for u in updates:
        now_ms = (time.perf_counter() - t0) * 1000
        if u.text and first_token_ms is None:
            first_token_ms = now_ms
        if not u.final:
            yield {"type": "partial", "text": u.text}
        else:
            yield {
                "type": "final",
                "text": u.text,
                "segments": u.segments,
                "first_token_ms": first_token_ms if first_token_ms is not None else now_ms,
                "total_ms": now_ms,
                "audio_sec": audio_sec,
                "rtf": (now_ms / 1000 / audio_sec) if audio_sec else None,
            }

