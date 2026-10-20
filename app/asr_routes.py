"""ASR 体验页的两个入口：上传文件（HTTP）和麦克风（WebSocket）。"""

import asyncio
import json
import time
from collections.abc import AsyncIterator

from fastapi import WebSocket, WebSocketDisconnect

from .asr import asr_events, transcribe_funasr, transcribe_http, transcribe_pcm
from .audio import decode_to_pcm16k, pcm_seconds
from .config import Hotword, ModelConfig, ModelStore
from .http_utils import ModelError
from .ws_utils import read_config, recv, send_event

EXPECTED_ERRORS = (ModelError, RuntimeError, KeyError, ValueError)


def parse_hotwords(raw: list[dict] | str | None) -> list[Hotword]:
    if isinstance(raw, str):
        raw = json.loads(raw or "[]")
    return [Hotword(**h) for h in raw or []]


# ---------------------------------------------------------------- 上传文件


async def file_events(
    model: ModelConfig, data: bytes, filename: str, content_type: str, *, hotwords: list[Hotword], language: str, stream: bool
) -> AsyncIterator[dict]:
    """识别一个上传的音频文件，产出事件（partial / final / error），由接口以 NDJSON 逐行发给浏览器。"""
    try:
        pcm = await decode_to_pcm16k(data)
        if model.protocol == "funasr_ws":
            updates = transcribe_pcm(model, pcm, hotwords=hotwords, language=language, stream=stream)
        else:
            # vLLM 直接收原始文件，不需要我们转码
            updates = transcribe_http(
                model, data, filename, content_type or "application/octet-stream", hotwords=hotwords, language=language, stream=stream
            )
        async for event in asr_events(updates, pcm_seconds(pcm)):
            yield event
    except EXPECTED_ERRORS as e:
        yield {"type": "error", "message": str(e)}


# ---------------------------------------------------------------- 麦克风


async def handle_mic(ws: WebSocket, store: ModelStore) -> None:
    """配置 JSON: {model_id, language, stream, hotwords}，然后是 PCM 帧，最后 {"type":"stop"}。"""
    await ws.accept()
    try:
        cfg = await read_config(ws)
        model = store.get(cfg["model_id"], "asr")
        hotwords = parse_hotwords(cfg.get("hotwords"))
        if model.protocol == "funasr_ws":
            await _live(ws, model, hotwords)
        else:
            await _record_then_transcribe(ws, model, hotwords, cfg)
    except WebSocketDisconnect:
        pass
    except EXPECTED_ERRORS as e:
        await send_event(ws, "error", message=str(e))
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass


async def _record_then_transcribe(ws: WebSocket, model: ModelConfig, hotwords: list[Hotword], cfg: dict) -> None:
    """vLLM 这类整段识别的模型：录完（收到 stop）再整段发出去。"""
    chunks: list[bytes] = []
    while True:
        msg = await recv(ws)
        if isinstance(msg, bytes):
            chunks.append(msg)
        elif msg.get("type") == "stop":
            break
    pcm = b"".join(chunks)
    updates = transcribe_pcm(model, pcm, hotwords=hotwords, language=cfg.get("language", ""), stream=bool(cfg.get("stream")))
    async for event in asr_events(updates, pcm_seconds(pcm)):
        await ws.send_text(json.dumps(event, ensure_ascii=False))


async def _live(ws: WebSocket, model: ModelConfig, hotwords: list[Hotword]) -> None:
    """FunASR：边说边把 PCM 转发给 FunASR，实时回传识别文字。"""
    audio_q: asyncio.Queue[bytes | None] = asyncio.Queue()
    stats = {"bytes": 0, "stop_at": 0.0}

    async def pump_from_browser() -> None:
        try:
            while True:
                msg = await recv(ws)
                if isinstance(msg, bytes):
                    stats["bytes"] += len(msg)
                    await audio_q.put(msg)
                elif msg.get("type") == "stop":
                    break
        except WebSocketDisconnect:
            pass
        stats["stop_at"] = time.perf_counter()
        await audio_q.put(None)

    async def pcm_iter() -> AsyncIterator[bytes]:
        while (chunk := await audio_q.get()) is not None:
            yield chunk

    pump = asyncio.create_task(pump_from_browser())
    try:
        async for u in transcribe_funasr(model, pcm_iter(), hotwords=hotwords):
            if not u.final:
                await send_event(ws, "partial", text=u.text)
                continue
            await send_event(
                ws,
                "final",
                text=u.text,
                segments=u.segments,
                audio_sec=stats["bytes"] / 2 / 16000,
                finish_ms=(time.perf_counter() - stats["stop_at"]) * 1000,
            )
    finally:
        pump.cancel()

