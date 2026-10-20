"""模型配置：用户在「模型管理」页添加的每一个 ASR / TTS / LLM 服务，都保存成一条 ModelConfig。

配置存在 data/models.json（可用环境变量 VP_DATA_DIR 改目录）。
"""

import json
import os
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("VP_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))

# 热词怎么传给模型（不同模型的传法不一样，见 docs/DESIGN.md「热词」一节）
#   none          不传热词
#   field         vLLM 的 hotwords 表单字段，逗号分隔        -> Fun-ASR-Nano
#   prompt        vLLM 的 prompt 表单字段，作为模型上下文     -> Qwen3-ASR
#   funasr_json   FunASR WebSocket，{"词": 权重} 的 JSON      -> Paraformer(SeACo)
#   funasr_text   FunASR WebSocket，空格分隔的纯文本
HotwordMode = Literal["none", "field", "prompt", "funasr_json", "funasr_text"]


class Hotword(BaseModel):
    word: str
    weight: float = 20


class ModelConfig(BaseModel):
    id: str = ""
    kind: Literal["asr", "tts", "llm"]
    name: str
    # openai_transcriptions: vLLM 的 /v1/audio/transcriptions
    # funasr_ws:             FunASR WebSocket 服务
    # openai_speech:         vLLM-Omni 的 /v1/audio/speech
    # openai_chat:           vLLM 的 /v1/chat/completions
    protocol: Literal["openai_transcriptions", "funasr_ws", "openai_speech", "openai_chat"]
    base_url: str
    api_key: str = ""
    model: str = ""  # 请求里的 model 字段，即 vllm serve 时的模型名

    # ---- ASR 相关 ----
    streaming: bool = False  # 服务支持流式输出
    hotword_mode: HotwordMode = "none"
    funasr_mode: Literal["2pass", "online", "offline"] = "2pass"
    # 以下三项只是「声明」部署时带了什么，用于界面提示；平台不会重复实现这些能力
    has_vad: bool = False
    has_punc: bool = False
    has_speaker: bool = False

    # ---- TTS 相关 ----
    tts_sample_rate: int = 24000  # 服务返回的 PCM 采样率，必须与服务端一致
    default_voice: str = ""

    # 额外请求参数，原样合并进请求（放各模型特有的参数）
    extra: dict = Field(default_factory=dict)


class ModelStore:
    def __init__(self, path: Path | None = None):
        self.path = path or DATA_DIR / "models.json"
        self._models: dict[str, ModelConfig] = {}
        if self.path.exists():
            for item in json.loads(self.path.read_text(encoding="utf-8")):
                m = ModelConfig(**item)
                self._models[m.id] = m

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = [m.model_dump() for m in self._models.values()]
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def list(self) -> list[ModelConfig]:
        return list(self._models.values())

    def get(self, model_id: str, kind: str | None = None) -> ModelConfig:
        m = self._models.get(model_id)
        if m is None:
            raise KeyError(f"模型不存在：{model_id}")
        if kind and m.kind != kind:
            raise KeyError(f"模型「{m.name}」不是 {kind.upper()} 模型")
        return m

    def upsert(self, model: ModelConfig) -> ModelConfig:
        model.name = model.name.strip()
        if not model.name:
            raise ValueError("模型名称不能为空")
        if any(m.name == model.name and m.kind == model.kind and m.id != model.id for m in self._models.values()):
            raise ValueError(f"已经有同名的 {model.kind.upper()} 模型「{model.name}」，请换一个名字")
        if not model.id:
            model.id = uuid.uuid4().hex[:8]
        self._models[model.id] = model
        self._save()
        return model

    def delete(self, model_id: str) -> None:
        self._models.pop(model_id, None)
        self._save()
