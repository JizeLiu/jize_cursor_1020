"""简单的能量 VAD：把连续的麦克风 PCM 切成「一句一句」的语音段。

只用于「语音唤醒」和「语音通话」。如果 ASR 服务端自带 VAD（比如 FunASR），ASR 体验页不需要它。
原理：每 20ms 算一次音量(dB)，高于「底噪 + margin_db」就算在说话；说完后静音超过 hangover_ms 就切段。
"""

from dataclasses import dataclass

import numpy as np

from .audio import SAMPLE_RATE

FRAME_SAMPLES = SAMPLE_RATE // 50  # 20ms
FRAME_BYTES = FRAME_SAMPLES * 2


@dataclass
class VadEvent:
    kind: str  # "start"：刚开口   "segment"：一段话结束
    pcm: bytes = b""


class EnergyVad:
    def __init__(
        self,
        margin_db: float = 12,  # 高于底噪多少 dB 算说话，越小越灵敏
        min_db: float = -50,  # 绝对音量下限
        hangover_ms: int = 700,  # 说完后静音多久才切段
        min_speech_ms: int = 250,  # 太短的声音当噪声丢弃
        preroll_ms: int = 300,  # 段首多保留一点，避免吞字头
        max_segment_ms: int = 30000,
    ):
        self.margin_db = margin_db
        self.min_db = min_db
        self.hangover_frames = hangover_ms // 20
        self.min_speech_frames = min_speech_ms // 20
        self.preroll_frames = preroll_ms // 20
        self.max_frames = max_segment_ms // 20

        self.noise_db = -60.0  # 自适应底噪
        self.level_db = -90.0  # 最近一帧音量，给界面画音量条
        self.speaking = False
        self._buf = b""
        self._preroll: list[bytes] = []
        self._segment: list[bytes] = []
        self._voiced_run = 0
        self._silence = 0
        self._speech_frames = 0

    @property
    def speech_ms(self) -> int:
        """当前这段话已经说了多久（只算有声的部分），没在说话时为 0。"""
        return self._speech_frames * 20 if self.speaking else 0

    def feed(self, pcm: bytes) -> list[VadEvent]:
        events: list[VadEvent] = []
        self._buf += pcm
        while len(self._buf) >= FRAME_BYTES:
            frame, self._buf = self._buf[:FRAME_BYTES], self._buf[FRAME_BYTES:]
            self._on_frame(frame, events)
        return events

    def flush(self) -> list[VadEvent]:
        """结束监听时，把还没说完的那段也交出去。"""
        events: list[VadEvent] = []
        if self.speaking:
            self._end_segment(events)
        return events

    def _on_frame(self, frame: bytes, events: list[VadEvent]) -> None:
        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768
        rms = float(np.sqrt(np.mean(samples**2)))
        db = 20 * np.log10(rms + 1e-9)
        self.level_db = db
        voiced = db > max(self.min_db, self.noise_db + self.margin_db)

        if not self.speaking:
            self.noise_db = self.noise_db * 0.95 + min(db, -20) * 0.05
            self._preroll.append(frame)
            self._preroll = self._preroll[-self.preroll_frames :]
            self._voiced_run = self._voiced_run + 1 if voiced else 0
            if self._voiced_run >= 3:  # 连续 60ms 有声才算开口
                self.speaking = True
                self._silence = 0
                self._speech_frames = self._voiced_run
                self._segment = list(self._preroll)
                self._preroll = []
                events.append(VadEvent("start"))
            return

        self._segment.append(frame)
        if voiced:
            self._silence = 0
            self._speech_frames += 1
        else:
            self._silence += 1
        if self._silence >= self.hangover_frames or len(self._segment) >= self.max_frames:
            self._end_segment(events)

    def _end_segment(self, events: list[VadEvent]) -> None:
        pcm = b"".join(self._segment)
        enough = self._speech_frames >= self.min_speech_frames
        self.speaking = False
        self._voiced_run = self._silence = self._speech_frames = 0
        self._segment = []
        self._preroll = []
        if enough:
            events.append(VadEvent("segment", pcm))
