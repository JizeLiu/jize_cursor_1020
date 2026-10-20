# 语音模型体验平台

体验自己部署的 **ASR / TTS** 模型的 Web 平台。模型都由你部署并提供接口（推荐 vLLM / vLLM-Omni，ASR 也可用 FunASR），平台负责调用和展示。

打开首页能看到四大功能入口（点卡片进入对应页面）和一个独立的「模型管理」页：

| 页面 | 能做什么 |
| --- | --- |
| 语音识别 ASR | 选模型、手动管理热词、流式/非流式、上传文件或麦克风录制、首字延迟和 RTF |
| 语音合成 TTS | PCM 流式实时播放、首包延迟、结果存成 WAV 整体回放和下载 |
| 语音唤醒 | 页面上自定义唤醒词（可多个，监听中增删立即生效），说出唤醒词后才开始识别 |
| 语音通话 | 选 ASR + TTS（+ 可选 LLM），像打电话一样对话，可打断 |
| 模型管理 | 添加模型（名称 + 接口地址）、一键模板、测试连接 |

为什么不用 Gradio：它做不了「通话」需要的全双工（边听边播、随时打断）、精确的首包计时、持续监听麦克风的唤醒。所以保留 FastAPI + 很薄的网页，逻辑仍全是 Python。

## 快速开始

需要 Python 3.11+，以及 ffmpeg（只有「上传文件」识别时用来解码音频）。

```bash
pip install -r requirements.txt
python mock_server.py     # 可选：模拟模型服务（端口 9000），没有 GPU 也能把整个平台跑通
python -m app             # 启动平台，打开 http://localhost:8787
```

打开后先到「模型管理」添加模型。用模拟服务联调时：HTTP 类模型地址填 `http://127.0.0.1:9000`，FunASR 填 `ws://127.0.0.1:9000/`。

> 麦克风只能在 `localhost` 或 https 下使用。在远程机器上跑时，请用 SSH 端口转发或 https 反向代理访问。

## 代码结构：想改哪里看哪里

整个平台 = **Python 后端做所有逻辑** + **一层很薄的网页**（只负责麦克风采集和播放声音）。网页是原生 HTML/JS，不需要 Node、不需要编译。

```
app/                      Python 后端（FastAPI）
  main.py                 所有接口都在这一个文件里，先看它
  config.py               模型配置的数据结构、保存到 data/models.json
  presets.py              「模型管理」页的一键模板
  asr.py                  调用 ASR：vLLM 协议 / FunASR WebSocket 协议
  tts.py                  调用 TTS，返回 PCM 流
  llm.py                  调用对话大模型（通话用）
  hotwords.py             热词按各模型要求的格式拼进请求
  vad.py                  VAD：把麦克风声音切成一句一句
  wake.py                 唤醒词匹配
  asr_routes.py           ASR 页的两个入口（文件 / 麦克风）
  ws_wake.py              语音唤醒的完整流程
  ws_call.py              语音通话的完整流程（一轮对话 = _run_turn）
static/                   网页
  index.html              五个页面的结构
  js/audio.js             麦克风采集 + PCM 播放器
  js/asr.js tts.js wake.js call.js models.js   各页面脚本
mock_server.py            模拟模型服务
tests/                    自动测试（pytest）
docs/DESIGN.md            设计说明（协议、流程图、已知限制）
```

## 各模型怎么配置（含热词）

**热词不需要在部署时传**，而是每次请求时由前端带上；你在「ASR 页」手动添加的热词会随每次识别请求一起发给模型。不同模型的传法不同，在「模型管理」里选对「热词传递方式」即可：

| 模型 | 协议 | 热词传递方式 | 说明 |
| --- | --- | --- | --- |
| Fun-ASR-Nano（vLLM） | `openai_transcriptions` | `hotwords 字段` | vLLM 官方文档支持，逗号分隔。非英文请填语言（如 `zh`） |
| Qwen3-ASR（vLLM） | `openai_transcriptions` | `prompt 字段` | 热词写进 prompt，作为模型上下文。vLLM 的 `hotwords` 字段对它是否生效取决于版本，用 prompt 最稳 |
| Paraformer（FunASR） | `funasr_ws` | `FunASR JSON` | 连接建立时下发 `{"词": 权重}`。**必须部署 SeACo / contextual 版本**，普通版会忽略热词 |

注意：热词是「提高识别概率」的提示，不保证 100% 纠正；词太多或和音频无关反而会变差，建议少而准。vLLM 跑 ASR 需要安装 `vllm[audio]`。

## 测试

```bash
python -m pytest        # 26 个测试：热词格式、唤醒词、VAD、所有接口和 WebSocket 流程（用 mock_server 当模型）
```

## 注意

- 这是本地/内网使用的工具：模型的 API Key 明文保存在 `data/models.json`（已加入 .gitignore），平台本身没有登录鉴权。
- TTS 生成的 WAV 存在 `data/outputs/`，不会自动清理。
