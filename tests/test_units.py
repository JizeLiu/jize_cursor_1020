"""不依赖网络的纯逻辑测试：热词格式、唤醒词匹配、句子切分、VAD。"""

import json

from app.config import Hotword, ModelConfig
from app.hotwords import funasr_param, http_form_fields
from app.vad import EnergyVad
from app.wake import match_wake_word
from app.ws_call import split_sentences

from .conftest import speech_pcm

HOT = [Hotword(word="通义千问", weight=30), Hotword(word="阿里巴巴", weight=20)]


def asr(mode: str, protocol: str = "openai_transcriptions") -> ModelConfig:
    return ModelConfig(kind="asr", name="m", protocol=protocol, base_url="http://x", hotword_mode=mode)


def test_hotword_formats():
    assert http_form_fields(asr("field"), HOT) == {"hotwords": "通义千问,阿里巴巴"}
    assert http_form_fields(asr("prompt"), HOT) == {"prompt": "通义千问 阿里巴巴"}
    assert http_form_fields(asr("none"), HOT) == {}
    assert http_form_fields(asr("field"), []) == {}
    assert json.loads(funasr_param(asr("funasr_json", "funasr_ws"), HOT)) == {"通义千问": 30, "阿里巴巴": 20}
    assert funasr_param(asr("funasr_text", "funasr_ws"), HOT) == "通义千问 阿里巴巴"
    assert funasr_param(asr("none", "funasr_ws"), HOT) == "{}"


def test_wake_exact_and_rest():
    m = match_wake_word("你好，小智，今天天气怎么样", ["你好小智"], fuzzy=0)
    assert m and m.word == "你好小智" and m.rest == "今天天气怎么样"


def test_wake_not_found_and_fuzzy():
    assert match_wake_word("今天天气不错", ["你好小智"], 0.25) is None
    assert match_wake_word("你好小志", ["你好小智"], 0) is None
    assert match_wake_word("你好小志", ["你好小智"], 0.25) is not None


def test_wake_multiple_words():
    assert match_wake_word("hey assistant", ["小智", "Hey Assistant"], 0).word == "Hey Assistant"


def test_split_sentences():
    s, rest = split_sentences("你好。今天天气很好！我们出去", first=False)
    assert s == ["你好。", "今天天气很好！"] and rest == "我们出去"


def test_split_sentences_first_comma_shortcut():
    text = "好的，我来帮你查一下今天的天气情况，稍等"
    s, rest = split_sentences(text, first=True)
    assert s == ["好的，我来帮你查一下今天的天气情况，"] and rest == "稍等"
    assert split_sentences(text, first=False) == ([], text)


def test_vad_segments_speech():
    vad = EnergyVad()
    events = vad.feed(speech_pcm(bursts=2))
    kinds = [e.kind for e in events]
    assert kinds == ["start", "segment", "start", "segment"]
    seconds = len(events[1].pcm) / 2 / 16000
    assert 1.2 < seconds < 2.6  # 1.2s 语音 + 前后保留 + 700ms 静音尾巴


def test_vad_ignores_silence():
    assert EnergyVad().feed(b"\x00\x00" * 16000 * 3) == []
