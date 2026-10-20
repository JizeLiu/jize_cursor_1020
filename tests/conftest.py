"""测试公共部分：启动 mock_server 当模型、临时数据目录、造测试用的语音。"""

import math
import os
import socket
import struct
import tempfile
import threading
import time

import pytest

# 必须在 import app 之前设置，让测试用临时目录，不污染 data/
os.environ["VP_DATA_DIR"] = tempfile.mkdtemp(prefix="vp-test-")

import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import mock_server  # noqa: E402
from app.main import app, store  # noqa: E402


def speech_pcm(bursts: int = 1, tone_sec: float = 1.2, gap_sec: float = 1.2) -> bytes:
    """合成「静音 - 一段较响的声音 - 静音」，用来测 VAD；16k s16le。"""
    rate = 16000

    def silence(sec: float) -> bytes:
        return b"\x00\x00" * int(rate * sec)

    def tone(sec: float) -> bytes:
        n = int(rate * sec)
        vals = [
            int(32767 * 0.3 * (math.sin(2 * math.pi * 200 * i / rate) + 0.5 * math.sin(2 * math.pi * 700 * i / rate)))
            for i in range(n)
        ]
        return struct.pack(f"<{n}h", *vals)

    out = silence(gap_sec)
    for _ in range(bursts):
        out += tone(tone_sec) + silence(gap_sec)
    return out


@pytest.fixture(scope="session")
def mock_base():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(mock_server.app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    yield f"127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture
def client(mock_base):
    for m in store.list():
        store.delete(m.id)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def models(client, mock_base):
    """往平台里注册指向模拟服务的各类模型，返回 {名字: id}。"""
    http, ws = f"http://{mock_base}", f"ws://{mock_base}/"
    specs = {
        "asr_field": dict(kind="asr", name="vLLM ASR(field)", protocol="openai_transcriptions", base_url=http, streaming=True, hotword_mode="field"),
        "asr_prompt": dict(kind="asr", name="vLLM ASR(prompt)", protocol="openai_transcriptions", base_url=http, streaming=True, hotword_mode="prompt"),
        "asr_funasr": dict(kind="asr", name="FunASR", protocol="funasr_ws", base_url=ws, streaming=True, hotword_mode="funasr_json"),
        "tts": dict(kind="tts", name="TTS", protocol="openai_speech", base_url=http, tts_sample_rate=24000),
        "llm": dict(kind="llm", name="LLM", protocol="openai_chat", base_url=http),
    }
    return {k: client.post("/api/models", json=v).json()["id"] for k, v in specs.items()}
