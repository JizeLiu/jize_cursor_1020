"""「模型管理」页里的一键模板。地址、模型名只是占位，按你的实际部署改。"""

from .config import ModelConfig

PRESETS: list[ModelConfig] = [
    ModelConfig(
        kind="asr",
        name="Fun-ASR-Nano（vLLM）",
        protocol="openai_transcriptions",
        base_url="http://127.0.0.1:8000",
        model="fun-asr-nano",  # vllm serve 时的 --served-model-name
        streaming=True,
        hotword_mode="field",  # 请求里带 hotwords=逗号分隔
        has_punc=True,
    ),
    ModelConfig(
        kind="asr",
        name="Qwen3-ASR（vLLM）",
        protocol="openai_transcriptions",
        base_url="http://127.0.0.1:8000",
        model="Qwen/Qwen3-ASR-1.7B",
        streaming=True,
        hotword_mode="prompt",  # Qwen3-ASR 把 prompt 当上下文，热词写在里面
        has_punc=True,
    ),
    ModelConfig(
        kind="asr",
        name="Paraformer（FunASR WebSocket）",
        protocol="funasr_ws",
        base_url="ws://127.0.0.1:10095",
        streaming=True,
        hotword_mode="funasr_json",  # 需要部署 SeACo / contextual 版本才生效
        has_vad=True,
        has_punc=True,
    ),
    ModelConfig(
        kind="tts",
        name="vLLM-Omni TTS",
        protocol="openai_speech",
        base_url="http://127.0.0.1:8091",
        model="",
        tts_sample_rate=24000,
    ),
    ModelConfig(
        kind="llm",
        name="vLLM 对话模型",
        protocol="openai_chat",
        base_url="http://127.0.0.1:8001",
        model="",
    ),
]
