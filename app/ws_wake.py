"""语音唤醒：持续监听麦克风，听到唤醒词才开始识别。

流程：
  麦克风 PCM -> VAD 切成一句一句 -> 每句送 ASR 转文字
     待机中：文字里有唤醒词？有 -> 进入「已唤醒」
     已唤醒：文字直接作为识别结果；超过 awake_sec 秒没人说话 -> 回到待机

（待机时的语音也会发给 ASR，用来判断是不是唤醒词。）
"""

import asyncio
import time

from fastapi import WebSocket, WebSocketDisconnect

from .asr import transcribe_text
from .asr_routes import EXPECTED_ERRORS, parse_hotwords
from .config import ModelStore
from .vad import EnergyVad
from .wake import match_wake_word
from .ws_utils import read_config, recv, send_event


async def handle_wake(ws: WebSocket, store: ModelStore) -> None:
    """配置 JSON: {model_id, wake_words, fuzzy, awake_sec, sensitivity, language, hotwords}

    监听中还可以发 {"type": "update", "wake_words": [...], "fuzzy": 0.25, "awake_sec": 8} 实时修改。
    """
    await ws.accept()
    try:
        cfg = await read_config(ws)
        model = store.get(cfg["model_id"], "asr")
        hotwords = parse_hotwords(cfg.get("hotwords"))
        wake_words = [w.strip() for w in cfg.get("wake_words", []) if w.strip()]
        fuzzy = float(cfg.get("fuzzy", 0.25))
        awake_sec = float(cfg.get("awake_sec", 8))
        language = cfg.get("language", "")
        vad = EnergyVad(margin_db=float(cfg.get("sensitivity", 12)))
    except EXPECTED_ERRORS as e:
        await send_event(ws, "error", message=str(e))
        await ws.close()
        return

    segments: asyncio.Queue[bytes] = asyncio.Queue()
    awake_until = 0.0  # 0 表示待机；否则是 time.monotonic() 的截止时间

    async def set_awake(awake: bool) -> None:
        nonlocal awake_until
        awake_until = time.monotonic() + awake_sec if awake else 0.0
        await send_event(ws, "state", state="awake" if awake else "sleeping", awake_sec=awake_sec)

    async def worker() -> None:
        """依次处理每个语音段（串行，保证结果顺序）。"""
        while True:
            pcm = await segments.get()
            t0 = time.perf_counter()
            try:
                text = await transcribe_text(model, pcm, hotwords=hotwords, language=language)
            except EXPECTED_ERRORS as e:
                await send_event(ws, "error", message=str(e))
                continue
            if not text:
                continue
            ms = (time.perf_counter() - t0) * 1000

            if awake_until:  # 已唤醒：这句话就是用户要说的内容
                await send_event(ws, "log", text=text, hit=False, ms=ms)
                await send_event(ws, "transcript", text=text)
                await set_awake(True)  # 续期
                continue

            hit = match_wake_word(text, wake_words, fuzzy)
            await send_event(ws, "log", text=text, hit=hit is not None, ms=ms)
            if hit:
                await set_awake(True)
                await send_event(ws, "wake", word=hit.word)
                if hit.rest:
                    await send_event(ws, "transcript", text=hit.rest)

    worker_task = asyncio.create_task(worker())
    await send_event(ws, "state", state="sleeping", awake_sec=awake_sec)
    last_level = 0.0
    try:
        while True:
            msg = await recv(ws)
            if isinstance(msg, dict):
                if msg.get("type") == "stop":
                    break
                if msg.get("type") == "update":  # 监听过程中修改唤醒词等设置，立即生效
                    wake_words = [w.strip() for w in msg.get("wake_words", wake_words) if w.strip()]
                    fuzzy = float(msg.get("fuzzy", fuzzy))
                    awake_sec = float(msg.get("awake_sec", awake_sec))
                continue
            for event in vad.feed(msg):
                if event.kind == "segment":
                    await segments.put(event.pcm)
            if awake_until and time.monotonic() > awake_until and not vad.speaking and segments.empty():
                await set_awake(False)
            now = time.monotonic()
            if now - last_level > 0.1:
                last_level = now
                await send_event(ws, "level", db=vad.level_db, speaking=vad.speaking)
    except WebSocketDisconnect:
        pass
    finally:
        worker_task.cancel()
        try:
            await ws.close()
        except RuntimeError:
            pass
