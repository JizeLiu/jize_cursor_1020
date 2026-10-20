"""FastAPI 入口：所有 HTTP / WebSocket 接口都在这里，一眼能看全。

  模型管理   GET/POST /api/models   DELETE /api/models/{id}   POST /api/models/test   GET /api/models/{id}/status   GET /api/presets
  部署示例   GET /api/deploy-examples（只读的示例脚本）
  ASR       POST /api/asr/file（上传文件）    WS /ws/asr（麦克风）
  TTS       POST /api/tts（流式 PCM）         GET /api/tts/files/{id}.wav（生成好的 WAV）
  唤醒/通话  WS /ws/wake    WS /ws/call
  前端页面   / （static/ 目录，无需编译）
"""

import json
import re
import time
import uuid
from pathlib import Path

import httpx
import websockets
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .asr_routes import file_events, handle_mic, parse_hotwords
from .audio import pcm_to_wav
from .config import DATA_DIR, ModelConfig, ModelStore
from .deploy_examples import load_examples
from .http_utils import ModelError, auth_headers, openai_url
from .presets import PRESETS
from .tts import stream_tts
from .ws_call import handle_call
from .ws_wake import handle_wake

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
OUTPUT_DIR = DATA_DIR / "outputs"
MAX_SAVED_WAVS = 200  # TTS 生成的 WAV 最多保留这么多个，超出的删最旧的

app = FastAPI(title="语音模型体验平台")
store = ModelStore()


# ---------------------------------------------------------------- 模型管理


@app.get("/api/models")
def list_models() -> list[ModelConfig]:
    return store.list()


@app.post("/api/models")
def save_model(model: ModelConfig) -> ModelConfig:
    try:
        return store.upsert(model)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/models/{model_id}")
def delete_model(model_id: str) -> dict:
    store.delete(model_id)
    return {"ok": True}


@app.get("/api/deploy-examples")
def deploy_examples() -> list[dict]:
    """「部署示例」页：只读的示例脚本，平台不会执行。"""
    return load_examples()


@app.get("/api/presets")
def presets() -> list[ModelConfig]:
    return PRESETS


async def check_model(model: ModelConfig) -> dict:
    """检测模型 API 是否存活：HTTP 服务请求 /v1/models，FunASR 服务尝试建立 WebSocket。"""
    started = time.perf_counter()
    try:
        if model.protocol == "funasr_ws":
            async with websockets.connect(model.base_url, additional_headers=auth_headers(model), open_timeout=6):
                pass
        else:
            async with httpx.AsyncClient(timeout=6) as client:
                resp = await client.get(openai_url(model.base_url, "models"), headers=auth_headers(model))
                resp.raise_for_status()
    except Exception as e:  # noqa: BLE001 —— 任何失败都原样告诉用户
        return {"ok": False, "message": f"{type(e).__name__}: {e}", "latency_ms": None}
    return {"ok": True, "message": "连接成功", "latency_ms": round((time.perf_counter() - started) * 1000)}


@app.post("/api/models/test")
async def test_model(model: ModelConfig) -> dict:
    """测试表单里还没保存的配置。"""
    return await check_model(model)


@app.get("/api/models/{model_id}/status")
async def model_status(model_id: str) -> dict:
    """检测已保存的模型是否在线。"""
    try:
        return await check_model(store.get(model_id))
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


# ---------------------------------------------------------------- ASR


@app.post("/api/asr/file")
async def asr_file(
    file: UploadFile = File(...),
    model_id: str = Form(...),
    language: str = Form(""),
    stream: bool = Form(False),
    hotwords: str = Form("[]"),
) -> StreamingResponse:
    """返回 NDJSON：每行一个事件 {"type": "partial"|"final"|"error", ...}。"""
    try:
        model = store.get(model_id, "asr")
        hot = parse_hotwords(hotwords)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    data = await file.read()

    async def body():
        async for event in file_events(
            model, data, file.filename or "audio", file.content_type or "", hotwords=hot, language=language, stream=stream
        ):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(body(), media_type="application/x-ndjson")


@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket) -> None:
    await handle_mic(ws, store)


# ---------------------------------------------------------------- TTS


class TtsRequest(BaseModel):
    model_id: str
    text: str
    voice: str = ""
    speed: float = 1.0
    stream: bool = True  # 是否让模型流式输出


def prune_outputs() -> None:
    files = sorted(OUTPUT_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime)
    for old in files[: max(0, len(files) - MAX_SAVED_WAVS)]:
        old.unlink(missing_ok=True)


@app.post("/api/tts")
async def tts(req: TtsRequest) -> StreamingResponse:
    """把模型返回的 PCM 原样流式转发给浏览器；同时攒起来，结束后存成 WAV（响应头里有 id）。"""
    try:
        model = store.get(req.model_id, "tts")
    except KeyError as e:
        raise HTTPException(400, str(e)) from e

    chunks = stream_tts(model, req.text, voice=req.voice, speed=req.speed, stream=req.stream)
    try:
        first = await anext(chunks, b"")  # 先取第一块：模型出错时能返回正确的 HTTP 错误
    except ModelError as e:
        raise HTTPException(502, str(e)) from e

    audio_id = uuid.uuid4().hex
    sample_rate = model.tts_sample_rate

    async def body():
        pcm = [first]
        try:
            yield first
            async for chunk in chunks:
                pcm.append(chunk)
                yield chunk
        finally:
            data = b"".join(pcm)
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            (OUTPUT_DIR / f"{audio_id}.wav").write_bytes(pcm_to_wav(data[: len(data) // 2 * 2], sample_rate))
            prune_outputs()

    return StreamingResponse(
        body(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(sample_rate), "X-Audio-Id": audio_id},
    )


@app.get("/api/tts/files/{audio_id}.wav")
def tts_file(audio_id: str) -> FileResponse:
    path = OUTPUT_DIR / f"{audio_id}.wav"
    if not re.fullmatch(r"[0-9a-f]{32}", audio_id) or not path.exists():
        raise HTTPException(404, "音频不存在")
    return FileResponse(path, media_type="audio/wav", filename=f"tts-{audio_id[:8]}.wav")


# ---------------------------------------------------------------- 唤醒 / 通话


@app.websocket("/ws/wake")
async def ws_wake(ws: WebSocket) -> None:
    await handle_wake(ws, store)


@app.websocket("/ws/call")
async def ws_call(ws: WebSocket) -> None:
    await handle_call(ws, store)


# 前端静态页面放最后，避免盖住上面的接口
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
