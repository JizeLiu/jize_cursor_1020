"""接口测试：用 mock_server 当模型，走完整的 HTTP / WebSocket 流程。"""

import io
import json
import wave

from .conftest import speech_pcm


def make_wav(seconds: float = 1.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x01\x00" * int(16000 * seconds))
    return buf.getvalue()


def ndjson(resp) -> list[dict]:
    return [json.loads(line) for line in resp.text.splitlines() if line]


# ---------------------------------------------------------------- 模型管理


def test_models_crud_and_presets(client):
    assert client.get("/api/models").json() == []
    assert len(client.get("/api/presets").json()) >= 5
    saved = client.post("/api/models", json=dict(kind="asr", name="a", protocol="funasr_ws", base_url="ws://x")).json()
    assert saved["id"]
    assert [m["name"] for m in client.get("/api/models").json()] == ["a"]
    client.delete(f"/api/models/{saved['id']}")
    assert client.get("/api/models").json() == []


def test_connection_test(client, mock_base):
    ok = client.post("/api/models/test", json=dict(kind="asr", name="a", protocol="openai_transcriptions", base_url=f"http://{mock_base}")).json()
    assert ok["ok"]
    ws = client.post("/api/models/test", json=dict(kind="asr", name="a", protocol="funasr_ws", base_url=f"ws://{mock_base}/")).json()
    assert ws["ok"]
    bad = client.post("/api/models/test", json=dict(kind="asr", name="a", protocol="openai_transcriptions", base_url="http://127.0.0.1:1")).json()
    assert not bad["ok"]


def test_saved_model_status_and_unique_name(client, mock_base):
    live = client.post("/api/models", json=dict(kind="asr", name="在线", protocol="openai_transcriptions", base_url=f"http://{mock_base}")).json()
    dead = client.post("/api/models", json=dict(kind="asr", name="离线", protocol="openai_transcriptions", base_url="http://127.0.0.1:1")).json()
    ok = client.get(f"/api/models/{live['id']}/status").json()
    assert ok["ok"] and ok["latency_ms"] is not None
    assert not client.get(f"/api/models/{dead['id']}/status").json()["ok"]
    assert client.get("/api/models/nope/status").status_code == 404

    dup = client.post("/api/models", json=dict(kind="asr", name="在线", protocol="funasr_ws", base_url="ws://x"))
    assert dup.status_code == 400 and "同名" in dup.json()["detail"]
    client.post("/api/models", json=dict(kind="tts", name="在线", protocol="openai_speech", base_url="http://x"))  # 不同类型可以重名
    live["base_url"] = "http://other"
    assert client.post("/api/models", json=live).status_code == 200  # 修改自己不算重名


# ---------------------------------------------------------------- ASR 文件


def asr_file(client, model_id, stream, hotwords):
    resp = client.post(
        "/api/asr/file",
        files={"file": ("a.wav", make_wav(), "audio/wav")},
        data={"model_id": model_id, "stream": str(stream).lower(), "hotwords": json.dumps(hotwords)},
    )
    return ndjson(resp)


def test_asr_file_non_stream(client, models):
    events = asr_file(client, models["asr_field"], False, [])
    assert [e["type"] for e in events] == ["final"]
    assert "模拟的识别结果" in events[0]["text"] and events[0]["audio_sec"] == 1.0


def test_asr_file_stream_hotwords_field(client, models):
    events = asr_file(client, models["asr_field"], True, [{"word": "通义千问", "weight": 20}, {"word": "阿里", "weight": 20}])
    assert events[-1]["type"] == "final"
    assert any(e["type"] == "partial" for e in events)
    assert "热词：通义千问,阿里" in events[-1]["text"]


def test_asr_file_hotwords_via_prompt(client, models):
    events = asr_file(client, models["asr_prompt"], False, [{"word": "通义千问", "weight": 20}, {"word": "阿里", "weight": 20}])
    assert "热词：通义千问 阿里" in events[-1]["text"]


def test_asr_file_funasr(client, models):
    events = asr_file(client, models["asr_funasr"], True, [{"word": "阿里巴巴", "weight": 30}])
    final = events[-1]
    assert final["type"] == "final" and "实时识别结果" in final["text"]
    assert '"阿里巴巴": 30' in final["text"]
    assert final["segments"][0]["spk"] == 0


def test_asr_file_bad_model_id(client):
    resp = client.post("/api/asr/file", files={"file": ("a.wav", make_wav(), "audio/wav")}, data={"model_id": "nope"})
    assert resp.status_code == 400


def test_asr_file_unreachable_model_reports_error(client):
    mid = client.post("/api/models", json=dict(kind="asr", name="bad", protocol="openai_transcriptions", base_url="http://127.0.0.1:1")).json()["id"]
    events = asr_file(client, mid, False, [])
    assert events[0]["type"] == "error" and "连接模型" in events[0]["message"]


# ---------------------------------------------------------------- ASR 麦克风


def test_asr_mic_funasr_live(client, models):
    with client.websocket_connect("/ws/asr") as ws:
        ws.send_json({"model_id": models["asr_funasr"], "hotwords": [{"word": "阿里巴巴", "weight": 30}]})
        pcm = speech_pcm()
        for i in range(0, len(pcm), 3200):
            ws.send_bytes(pcm[i : i + 3200])
        ws.send_json({"type": "stop"})
        events = []
        while not events or events[-1]["type"] != "final":
            events.append(ws.receive_json())
    assert any(e["type"] == "partial" for e in events)
    assert "实时识别结果" in events[-1]["text"] and events[-1]["finish_ms"] >= 0


def test_asr_mic_http_record_then_transcribe(client, models):
    with client.websocket_connect("/ws/asr") as ws:
        ws.send_json({"model_id": models["asr_field"], "stream": True})
        ws.send_bytes(speech_pcm())
        ws.send_json({"type": "stop"})
        events = []
        while not events or events[-1]["type"] != "final":
            events.append(ws.receive_json())
    assert "模拟的识别结果" in events[-1]["text"]


# ---------------------------------------------------------------- TTS


def test_tts_stream_and_wav(client, models):
    with client.stream("POST", "/api/tts", json={"model_id": models["tts"], "text": "你好世界", "stream": True}) as resp:
        assert resp.status_code == 200 and resp.headers["x-sample-rate"] == "24000"
        pcm = b"".join(resp.iter_bytes())
        audio_id = resp.headers["x-audio-id"]
    assert len(pcm) > 24000  # 至少 0.5 秒
    wav = client.get(f"/api/tts/files/{audio_id}.wav")
    assert wav.status_code == 200 and wav.content[:4] == b"RIFF"
    with wave.open(io.BytesIO(wav.content)) as w:
        assert w.getframerate() == 24000 and w.getnframes() * 2 == len(pcm)


def test_tts_file_rejects_bad_id(client):
    assert client.get("/api/tts/files/..%2Fsecret.wav").status_code in (404, 422)
    assert client.get("/api/tts/files/" + "0" * 32 + ".wav").status_code == 404


def test_tts_model_error_is_http_502(client):
    mid = client.post("/api/models", json=dict(kind="tts", name="bad", protocol="openai_speech", base_url="http://127.0.0.1:1")).json()["id"]
    resp = client.post("/api/tts", json={"model_id": mid, "text": "x"})
    assert resp.status_code == 502


# ---------------------------------------------------------------- 唤醒 / 通话


def collect_until(ws, stop_type: str, limit: int = 200) -> list[dict]:
    events = []
    for _ in range(limit):
        ev = ws.receive_json()
        events.append(ev)
        if ev["type"] == stop_type:
            return events
    raise AssertionError(f"没等到 {stop_type}：{events[-5:]}")


def send_pcm(ws, pcm: bytes) -> None:
    for i in range(0, len(pcm), 3200):
        ws.send_bytes(pcm[i : i + 3200])


def test_wake_flow(client, models):
    cfg = {"model_id": models["asr_field"], "wake_words": ["模拟的识别"], "fuzzy": 0, "awake_sec": 30}
    with client.websocket_connect("/ws/wake") as ws:
        ws.send_json(cfg)
        assert ws.receive_json()["state"] == "sleeping"
        send_pcm(ws, speech_pcm())
        events = collect_until(ws, "wake")
        assert any(e["type"] == "log" and e["hit"] for e in events)
        assert any(e["type"] == "state" and e["state"] == "awake" for e in events)
        # 唤醒词之后的同一句内容，作为第一条识别结果
        assert collect_until(ws, "transcript")[-1]["text"].startswith("结果")
        # 已唤醒后的下一句应直接成为识别结果
        send_pcm(ws, speech_pcm())
        events = collect_until(ws, "transcript")
        assert "模拟的识别结果" in events[-1]["text"]
        ws.send_json({"type": "stop"})


def test_wake_words_can_be_changed_while_listening(client, models):
    cfg = {"model_id": models["asr_field"], "wake_words": ["完全不相关"], "fuzzy": 0, "awake_sec": 30}
    with client.websocket_connect("/ws/wake") as ws:
        ws.send_json(cfg)
        ws.receive_json()
        send_pcm(ws, speech_pcm())
        assert collect_until(ws, "log")[-1]["hit"] is False
        # 用户在页面上改了唤醒词：不用重新开始监听，立刻生效
        ws.send_json({"type": "update", "wake_words": ["模拟的识别"]})
        send_pcm(ws, speech_pcm())
        events = collect_until(ws, "wake")
        assert any(e["type"] == "log" and e["hit"] for e in events)
        ws.send_json({"type": "stop"})


def test_wake_word_not_matched_stays_asleep(client, models):
    cfg = {"model_id": models["asr_field"], "wake_words": ["你好小智"], "fuzzy": 0}
    with client.websocket_connect("/ws/wake") as ws:
        ws.send_json(cfg)
        ws.receive_json()
        send_pcm(ws, speech_pcm())
        events = collect_until(ws, "log")
        assert events[-1]["hit"] is False
        ws.send_json({"type": "stop"})


def test_call_flow_with_llm(client, models):
    cfg = {"asr_id": models["asr_field"], "tts_id": models["tts"], "llm_id": models["llm"], "barge_in": False}
    with client.websocket_connect("/ws/call") as ws:
        ws.send_json(cfg)
        send_pcm(ws, speech_pcm())
        got_audio, texts, metrics = False, [], {}
        for _ in range(500):
            msg = ws.receive()
            if msg.get("bytes"):
                got_audio = True
                break
            ev = json.loads(msg["text"])
            if ev["type"] in ("user_text", "assistant_text"):
                texts.append(ev["text"])
            if ev["type"] == "metrics":
                metrics = ev
        ws.send_json({"type": "stop"})
    assert got_audio
    assert any("模拟的识别结果" in t for t in texts)
    assert {"asr_ms", "llm_first_ms", "tts_first_ms"} <= metrics.keys()


def test_call_echo_mode_without_llm(client, models):
    cfg = {"asr_id": models["asr_field"], "tts_id": models["tts"], "barge_in": False}
    with client.websocket_connect("/ws/call") as ws:
        ws.send_json(cfg)
        send_pcm(ws, speech_pcm())
        notes = []
        for _ in range(100):
            msg = ws.receive()
            if msg.get("bytes"):
                break
            ev = json.loads(msg["text"])
            if ev["type"] == "assistant_text":
                notes.append(ev.get("note"))
        ws.send_json({"type": "stop"})
    assert notes and "复读" in notes[0]
