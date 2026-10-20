"""语音通话：像打电话一样和 AI 对话。

一轮对话的流程（CallSession._turn）：
  用户说完一句（VAD 切段）
    -> ASR 转文字
    -> LLM 流式生成回复（没配 LLM 就复读用户的话）
    -> 回复按句切开，一句一句送 TTS（PCM 流式）
    -> PCM 通过 WebSocket 实时发给浏览器播放

打断（barge-in）：AI 正在思考/说话时，如果用户持续说话超过 BARGE_IN_MS，就取消这一轮
（LLM、TTS 请求都会被取消），并通知浏览器立刻停止播放，同时把用户这句话当作下一轮的输入。
不允许打断时：AI 忙的时候用户说的话会被忽略。
"""

import asyncio
import re
import time

from fastapi import WebSocket, WebSocketDisconnect

from .asr import transcribe_text
from .asr_routes import EXPECTED_ERRORS, parse_hotwords
from .config import Hotword, ModelConfig, ModelStore
from .llm import stream_chat
from .tts import stream_tts
from .vad import EnergyVad
from .ws_utils import read_config, recv, send_event

BARGE_IN_MS = 240  # 用户连续说话多久才算「打断」，太短容易被咳嗽、回声误触发

DEFAULT_SYSTEM_PROMPT = "你是一个语音通话助手。回答要简短、口语化，一次不超过三句话，不要使用 markdown、列表或表情符号。"

_SENTENCE_END = re.compile(r"[。！？!?；;\n]")
_COMMA = re.compile(r"[，,、]")


def split_sentences(buf: str, first: bool) -> tuple[list[str], str]:
    """从 LLM 已输出的文字里切出完整的句子，返回 (句子列表, 剩余未成句的文字)。

    first=True 表示还没有说出第一句话：为了让 AI 尽快开口，文字够长时在逗号处提前切一刀。
    """
    sentences: list[str] = []
    while True:
        m = _SENTENCE_END.search(buf)
        end = m.start() if m else -1
        if end < 0 and first and not sentences and len(buf) >= 14:
            commas = [c.start() for c in _COMMA.finditer(buf) if c.start() >= 5]
            end = commas[-1] if commas else -1
        if end < 0:
            return sentences, buf
        sentence = buf[: end + 1].strip()
        if sentence:
            sentences.append(sentence)
        buf = buf[end + 1 :]


class CallSession:
    def __init__(
        self,
        ws: WebSocket,
        asr: ModelConfig,
        tts: ModelConfig,
        llm: ModelConfig | None,
        hotwords: list[Hotword],
        system_prompt: str,
        barge_in: bool,
    ):
        self.ws, self.asr, self.tts, self.llm = ws, asr, tts, llm
        self.hotwords, self.system_prompt, self.barge_in = hotwords, system_prompt, barge_in
        self.history: list[dict] = []
        self.turn_task: asyncio.Task | None = None
        self.state = ""
        self.playing_until = 0.0  # 浏览器预计播放结束的时间（time.monotonic）
        self.metrics: dict = {}

    # ---------------------------------------------------------------- 主循环：收麦克风音频

    async def run(self) -> None:
        vad = EnergyVad()
        await self._set_state("listening")
        last_level = 0.0
        try:
            while True:
                msg = await recv(self.ws)
                if isinstance(msg, dict):
                    if msg.get("type") == "stop":
                        break
                    continue
                for event in vad.feed(msg):
                    if event.kind == "segment":
                        if self._ai_is_busy():
                            if not self.barge_in:
                                continue  # 不允许打断：AI 说话期间的人声直接忽略
                            await self._interrupt()  # 整段话在一个音频包里到达时，上面的实时检测来不及触发
                        self._start_turn(event.pcm, speech_end=time.perf_counter())
                if self.barge_in and vad.speech_ms >= BARGE_IN_MS and self._ai_is_busy():
                    await self._interrupt()
                now = time.monotonic()
                if now - last_level > 0.1:
                    last_level = now
                    await send_event(self.ws, "level", db=vad.level_db, speaking=vad.speaking)
        except WebSocketDisconnect:
            pass
        finally:
            await self._cancel_turn()

    def _ai_is_busy(self) -> bool:
        running = self.turn_task is not None and not self.turn_task.done()
        return running or time.monotonic() < self.playing_until

    async def _set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            await send_event(self.ws, "state", state=state)

    async def _update_metrics(self, **values: float) -> None:
        self.metrics.update(values)
        await send_event(self.ws, "metrics", **self.metrics)

    # ---------------------------------------------------------------- 一轮对话

    def _start_turn(self, pcm: bytes, speech_end: float) -> None:
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.turn_task = asyncio.create_task(self._turn(pcm, speech_end))

    async def _cancel_turn(self) -> None:
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
            await asyncio.gather(self.turn_task, return_exceptions=True)
        self.playing_until = 0.0

    async def _interrupt(self) -> None:
        await self._cancel_turn()
        await send_event(self.ws, "clear")  # 浏览器立刻停止播放
        await send_event(self.ws, "interrupted")
        await self._set_state("listening")

    async def _turn(self, pcm: bytes, speech_end: float) -> None:
        try:
            await self._run_turn(pcm, speech_end)
        except EXPECTED_ERRORS as e:
            await send_event(self.ws, "error", message=str(e))
            await self._set_state("listening")

    async def _run_turn(self, pcm: bytes, speech_end: float) -> None:
        self.metrics = {}
        await self._set_state("thinking")

        t0 = time.perf_counter()
        user_text = await transcribe_text(self.asr, pcm, hotwords=self.hotwords)
        await self._update_metrics(asr_ms=(time.perf_counter() - t0) * 1000)
        if not user_text:
            await self._set_state("listening")
            return
        await send_event(self.ws, "user_text", text=user_text)

        sentences: asyncio.Queue[str | None] = asyncio.Queue()
        reply_parts: list[str] = []
        producer = asyncio.create_task(self._produce_sentences(user_text, sentences, reply_parts))
        try:
            audio_started = False
            while (sentence := await sentences.get()) is not None:
                audio_started = await self._speak(sentence, speech_end, audio_started)
            await producer  # 如果 LLM 出错，异常在这里抛出
        finally:
            producer.cancel()

        self.history += [{"role": "user", "content": user_text}, {"role": "assistant", "content": "".join(reply_parts)}]
        while time.monotonic() < self.playing_until:  # 等浏览器把声音播完
            await asyncio.sleep(0.05)
        await send_event(self.ws, "turn_end")
        await self._set_state("listening")

    async def _produce_sentences(self, user_text: str, out: "asyncio.Queue[str | None]", reply_parts: list[str]) -> None:
        """把 LLM 的流式输出切成句子放进队列；没有 LLM 就把用户的话原样复读。"""
        try:
            if self.llm is None:
                reply_parts.append(user_text)
                await send_event(self.ws, "assistant_text", text=user_text, note="复读模式（未配置 LLM）")
                await out.put(user_text)
                return

            messages = [{"role": "system", "content": self.system_prompt}, *self.history, {"role": "user", "content": user_text}]
            t0 = time.perf_counter()
            buf, said_first = "", False
            async for delta in stream_chat(self.llm, messages):
                if not reply_parts:
                    await self._update_metrics(llm_first_ms=(time.perf_counter() - t0) * 1000)
                reply_parts.append(delta)
                await send_event(self.ws, "assistant_text", text="".join(reply_parts))
                buf += delta
                ready, buf = split_sentences(buf, first=not said_first)
                for s in ready:
                    said_first = True
                    await out.put(s)
            if buf.strip():
                await out.put(buf.strip())
        finally:
            await out.put(None)

    async def _speak(self, sentence: str, speech_end: float, audio_started: bool) -> bool:
        """把一句话送 TTS，PCM 一边收一边转发给浏览器。返回本轮是否已经开始出声。"""
        sample_rate = self.tts.tts_sample_rate
        t0 = time.perf_counter()
        first_chunk = True
        async for chunk in stream_tts(self.tts, sentence):
            if first_chunk:
                first_chunk = False
                if "tts_first_ms" not in self.metrics:
                    await self._update_metrics(tts_first_ms=(time.perf_counter() - t0) * 1000)
            if not audio_started:
                audio_started = True
                await send_event(self.ws, "audio_start", sample_rate=sample_rate)
                await self._set_state("speaking")
                await self._update_metrics(e2e_ms=(time.perf_counter() - speech_end) * 1000)
            await self.ws.send_bytes(chunk)
            now = time.monotonic()
            self.playing_until = max(now, self.playing_until) + len(chunk) / 2 / sample_rate
        return audio_started


async def handle_call(ws: WebSocket, store: ModelStore) -> None:
    """配置 JSON: {asr_id, tts_id, llm_id(可空), system_prompt, barge_in, hotwords}"""
    await ws.accept()
    try:
        cfg = await read_config(ws)
        session = CallSession(
            ws,
            asr=store.get(cfg["asr_id"], "asr"),
            tts=store.get(cfg["tts_id"], "tts"),
            llm=store.get(cfg["llm_id"], "llm") if cfg.get("llm_id") else None,
            hotwords=parse_hotwords(cfg.get("hotwords")),
            system_prompt=cfg.get("system_prompt") or DEFAULT_SYSTEM_PROMPT,
            barge_in=bool(cfg.get("barge_in", True)),
        )
    except (KeyError, ValueError) as e:
        await send_event(ws, "error", message=str(e))
        await ws.close()
        return
    try:
        await session.run()
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass
