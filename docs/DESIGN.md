# 设计说明

## 1. 整体结构

```
浏览器（只做麦克风采集、声音播放、界面）
   │  HTTP / WebSocket（同源，无跨域问题）
   ▼
Python 后端（FastAPI）── 所有逻辑：热词拼装、VAD、唤醒、对话编排、延迟统计
   │  HTTP / SSE / WebSocket
   ▼
你部署的模型：vLLM（ASR / LLM）、vLLM-Omni（TTS）、FunASR（ASR WebSocket）
```

为什么浏览器不直连模型：直连会遇到跨域，API Key 也会暴露在页面里。现在后端只会访问你在「模型管理」里配置过的地址，不是开放代理。

## 2. 热词

结论：**热词是每次请求时带的参数，不是部署时配置。** 部署时只需要选对模型版本。

| 模型 | 传法 | 部署侧要求 |
| --- | --- | --- |
| Fun-ASR-Nano（vLLM） | 表单字段 `hotwords=词1,词2` | 无 |
| Qwen3-ASR（vLLM） | 表单字段 `prompt=词1 词2`（变成模型的上下文） | 无 |
| Paraformer（FunASR） | WebSocket 首包 `hotwords={"词":权重}` | 必须是 SeACo / contextual 模型 |

- 平台把「怎么传」做成模型的一项配置 `hotword_mode`（`field` / `prompt` / `funasr_json` / `funasr_text` / `none`），逻辑集中在 `app/hotwords.py` 一个文件。新模型的传法不一样时，加一种 mode 即可。
- 热词存在浏览器（按模型分开），每次请求由前端随请求发给后端。
- 热词只是「偏置」，不是强制替换。vLLM 的 Fun-ASR 验证记录里，单个热词有时不改变输出，重复写几次才改变——效果要用你自己的音频验证。

## 3. VAD 与声纹（CAM++）

| 能力 | 建议放哪 | 平台怎么处理 |
| --- | --- | --- |
| VAD | ASR 服务端（如 FunASR 的 fsmn-vad） | 在模型里勾选「部署时已带 VAD」，ASR 页提示由服务端切分长音频 |
| 标点 | ASR 服务端 | 只作为标记显示 |
| 说话人/声纹 | ASR 服务端流水线 | 勾选后，若结果带 `spk` 字段，分句表里会显示说话人 |
| 客户端 VAD | 后端 `vad.py`（能量法） | 「语音唤醒」「通话」始终使用，用来切分语音和检测打断 |

这几个勾选项**只影响界面提示**，平台不会重复实现这些能力。纯 vLLM 部署的 ASR 没有 VAD 也能正常使用，长音频请先自行切分。

尚未实现：把 CAM++ 作为独立的声纹验证服务（注册说话人 + 校验，用于「只响应某个人」）。扩展方式：增加一类模型，在 VAD 切段之后、ASR 之前插一步校验。

## 4. 协议

| 类型 | `protocol` | 接口 |
| --- | --- | --- |
| ASR | `openai_transcriptions` | `POST /v1/audio/transcriptions`（multipart）；`stream=true` 时返回 SSE |
| ASR | `funasr_ws` | FunASR WebSocket：首包 JSON 配置 → 持续发 16k PCM → `{"is_speaking": false}` 结束 |
| TTS | `openai_speech` | `POST /v1/audio/speech`，`response_format=pcm` + `stream=true`，返回 PCM 流 |
| LLM | `openai_chat` | `POST /v1/chat/completions`，`stream=true` |

每个模型的「额外请求参数」JSON 会原样合并进请求，用来放各模型特有的参数。

## 5. 平台自己的接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/asr/file` | 上传文件识别，返回 NDJSON 事件流 |
| `WS /ws/asr` | 麦克风识别 |
| `POST /api/tts` | 返回 PCM 流（响应头 `X-Sample-Rate`、`X-Audio-Id`）；后端同时存成 WAV |
| `GET /api/tts/files/{id}.wav` | 取生成好的 WAV |
| `GET /api/models/{id}/status`、`POST /api/models/test` | 检测已保存/表单中的模型 API 是否在线（HTTP 请求 `/v1/models`，FunASR 尝试建立 WebSocket），返回延迟 |
| `WS /ws/wake`、`WS /ws/call` | 语音唤醒、语音通话 |
| `GET/POST /api/models` 等 | 模型管理 |

WebSocket 统一约定：浏览器先发一条 JSON 配置，随后发二进制 16k/16bit/单声道 PCM 帧，最后发 `{"type":"stop"}`。后端回 JSON 事件 `{"type": "...", ...}`；通话时还会回二进制 PCM 供浏览器播放。

## 6. 各功能的流程

**ASR**：文件 → 后端 → 模型，结果以事件流逐步回传。FunASR 麦克风是实时转发，其他协议录完再整段发送。

**TTS**：模型的 PCM 流 → 后端原样转发（同时累积） → 浏览器边收边播。首包延迟 = 点击合成到收到第一块音频的时间；结束后后端把累积的 PCM 存成 WAV，页面可整体回放、下载。

**语音唤醒**（`ws_wake.py`）：
```
麦克风 → VAD 切成一句一句 → 每句送 ASR → 待机：文字里有唤醒词？ → 已唤醒 → 之后每句直接作为识别结果
                                                        超过 awake_sec 没人说话 → 回到待机
```
唤醒词由用户在页面上自定义（保存在浏览器 localStorage，随连接配置发给后端；监听中增删会发 `{"type":"update",...}` 立即生效）。没有拼音库，无法处理同音字；可用「模糊匹配」容忍少量错字，或把常见误识别写法也加入唤醒词。待机时的语音也会发给 ASR（用于判断是否是唤醒词）。

**语音通话**（`ws_call.py`，一轮对话 = `_run_turn`）：
```
用户说完一句 → ASR → LLM 流式生成 → 按句切分（首句在逗号处提前切）→ TTS 流式 → PCM 发给浏览器播放
```
- 需要一个对话大模型才能真正聊天；不配置时是复读模式，可单独测 ASR + TTS 链路。
- 打断：AI 思考或说话期间，VAD 检测到用户开口 → 取消这一轮的 LLM/TTS 请求，并通知浏览器立刻停止播放。使用扬声器时回声可能误触发打断，建议戴耳机。
- 延迟：ASR 识别、LLM 首字、TTS 首包、端到端（用户语音段结束 → 听到第一个声音，含 VAD 静音等待）。

## 7. 已知限制

- vLLM 协议的 ASR 目前是整段识别（可流式输出文字，但不是边说边识别）；真正的边说边识别只有 FunASR WebSocket 支持。vLLM 的 `/v1/realtime` 可作为后续新增的适配器。
- VAD 是能量法，嘈杂环境需调灵敏度；可替换为 Silero VAD。
- 平台没有登录鉴权，API Key 明文存在 `data/models.json`，仅适合本地/内网。
- 协议字段按各模型文档实现，仅用模拟服务验证过；接入真实服务后请确认热词效果、TTS 采样率和 voice 参数。
