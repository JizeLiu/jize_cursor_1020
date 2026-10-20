"""模拟模型服务：没有 GPU / 没部署真实模型时，用它联调整个平台。

启动：python mock_server.py        （默认端口 9000，可用 MOCK_PORT 修改）
  HTTP  /v1/audio/transcriptions   模拟 vLLM ASR（支持 stream=true 的 SSE，会回显收到的热词）
  HTTP  /v1/audio/speech           模拟 vLLM-Omni TTS（返回合成的音调 PCM，stream 时分块输出）
  HTTP  /v1/chat/completions       模拟 LLM（复述用户的话，SSE）
  WS    ws://127.0.0.1:9000/       模拟 FunASR 的 2pass 协议
"""

import asyncio
import json
import math
import os
import struct

import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

TTS_RATE = 24000
app = FastAPI()


@app.get("/v1/models")
def models() -> dict:
    return {"data": [{"id": "mock-model"}]}


# ---------------------------------------------------------------- ASR (HTTP)


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(""),
    stream: bool = Form(False),
    hotwords: str = Form(""),
    prompt: str = Form(""),
    mock_segments: str = Form(""),  # 模型 extra 里写 {"mock_segments": "1"} 时，模拟带说话人的流水线服务
):
    size = len(await file.read())
    hot = hotwords or prompt
    text = f"这是模拟的识别结果，收到音频 {size} 字节{f'，热词：{hot}' if hot else ''}。"
    if not stream:
        if mock_segments:
            segments = [{"text": "第一句。", "start": 0.0, "end": 1.2, "spk": 0}, {"text": "第二句。", "start": 1.3, "end": 2.5, "spk": 1}]
            return {"text": "第一句。第二句。", "segments": segments}
        return {"text": text}

    async def sse():
        await asyncio.sleep(0.3)
        for ch in text:
            yield f"data: {json.dumps({'choices': [{'delta': {'content': ch}}]}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0.05)
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")


# ---------------------------------------------------------------- TTS


def make_tone(text: str, seconds: float) -> bytes:
    n = int(TTS_RATE * seconds)
    base = 220 + (ord(text[0]) % 12) * 30 if text else 220
    samples = []
    for i in range(n):
        t = i / TTS_RATE
        env = min(1.0, t * 20, (seconds - t) * 20)
        v = math.sin(2 * math.pi * base * (1 + 0.02 * math.sin(2 * math.pi * 5 * t)) * t) * 0.35 * env
        samples.append(int(v * 32767))
    return struct.pack(f"<{n}h", *samples)


@app.post("/v1/audio/speech")
async def speech(request: Request):
    body = await request.json()
    text = str(body.get("input", ""))
    pcm = make_tone(text, max(0.6, min(20.0, len(text) * 0.18)))
    streaming = bool(body.get("stream"))

    async def pcm_stream():
        await asyncio.sleep(0.35)  # 模拟模型的首包延迟
        step = int(TTS_RATE * 2 * 0.1)
        for i in range(0, len(pcm), step):
            yield pcm[i : i + step]
            if streaming:
                await asyncio.sleep(0.06)

    return StreamingResponse(pcm_stream(), media_type="audio/pcm")


# ---------------------------------------------------------------- LLM


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    last_user = next((m["content"] for m in reversed(body.get("messages", [])) if m["role"] == "user"), "")
    reply = f"你说的是：{last_user}。这是模拟大模型的回复，用来测试通话链路。"
    if not body.get("stream"):
        return JSONResponse({"choices": [{"message": {"role": "assistant", "content": reply}}]})

    async def sse():
        await asyncio.sleep(0.2)
        for i in range(0, len(reply), 4):
            yield f"data: {json.dumps({'choices': [{'delta': {'content': reply[i:i + 4]}}]}, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0.04)
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")


# ---------------------------------------------------------------- FunASR WebSocket


@app.websocket("/")
async def funasr(ws: WebSocket):
    await ws.accept()
    cfg: dict = {"mode": "2pass", "hotwords": ""}
    total = since_partial = 0
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                total += len(msg["bytes"])
                since_partial += len(msg["bytes"])
                if since_partial >= 16000 * 2 * 0.6 and cfg["mode"] != "offline":
                    since_partial = 0
                    mode = "online" if cfg["mode"] == "online" else "2pass-online"
                    await ws.send_text(json.dumps({"mode": mode, "text": "模拟", "is_final": False}, ensure_ascii=False))
                continue
            data = json.loads(msg["text"])
            if "mode" in data:
                cfg.update(data)
            if data.get("is_speaking") is False:
                hot = cfg.get("hotwords")
                text = f"这是模拟的实时识别结果，共收到 {total} 字节{f'，热词 {hot}' if hot and hot != '{}' else ''}。"
                mode = "2pass-offline" if cfg["mode"] == "2pass" else cfg["mode"]
                await ws.send_text(
                    json.dumps(
                        {
                            "mode": mode,
                            "text": text,
                            "is_final": True,
                            "stamp_sents": [{"text_seg": text, "start": 0, "end": total // 32, "spk": 0}],
                        },
                        ensure_ascii=False,
                    )
                )
                total = since_partial = 0
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("MOCK_PORT", "9000")), log_level="warning")
