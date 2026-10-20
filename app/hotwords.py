"""把用户在前端填的热词，按模型要求的格式拼进请求。

热词不是「部署时」配置的，而是「每次请求时」带上；唯一要求是模型本身支持（例如要用 SeACo-Paraformer，而不是普通 Paraformer）。
"""

import json

from .config import Hotword, ModelConfig


def http_form_fields(model: ModelConfig, hotwords: list[Hotword]) -> dict[str, str]:
    """vLLM /v1/audio/transcriptions 的表单字段。"""
    if not hotwords:
        return {}
    words = [h.word for h in hotwords]
    if model.hotword_mode == "field":
        return {"hotwords": ",".join(words)}
    if model.hotword_mode == "prompt":
        return {"prompt": " ".join(words)}
    return {}


def funasr_param(model: ModelConfig, hotwords: list[Hotword]) -> str:
    """FunASR WebSocket 首包里的 hotwords 字段。"""
    if model.hotword_mode == "funasr_text":
        return " ".join(h.word for h in hotwords)
    if model.hotword_mode == "funasr_json":
        return json.dumps({h.word: h.weight for h in hotwords}, ensure_ascii=False)
    return "{}"
