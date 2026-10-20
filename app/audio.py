"""音频小工具。统一约定：ASR 用 16kHz / 单声道 / 16bit 小端 PCM（bytes）。"""

import asyncio
import io
import shutil
import subprocess
import wave

SAMPLE_RATE = 16000


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def pcm_seconds(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> float:
    return len(pcm) / 2 / sample_rate


def _decode_sync(data: bytes) -> bytes:
    """任意格式音频 -> 16k 单声道 PCM，依赖系统里的 ffmpeg。"""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("需要安装 ffmpeg 才能解码该音频（apt install ffmpeg / brew install ffmpeg）")
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "pipe:1"],
        input=data,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"音频解码失败：{proc.stderr.decode(errors='ignore')[:200]}")
    return proc.stdout


async def decode_to_pcm16k(data: bytes) -> bytes:
    return await asyncio.to_thread(_decode_sync, data)
