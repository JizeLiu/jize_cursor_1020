# 语音模型体验平台

体验自己部署的 **ASR / TTS** 模型的 Web 平台。所有模型都由你自己部署并提供接口（推荐 vLLM / vLLM-Omni，ASR 也可用 FunASR），平台只负责调用与展示。

| 功能 | 说明 |
| --- | --- |
| 语音识别 ASR | 选模型、管理热词、流式/非流式、上传文件或麦克风录制（FunASR 支持边说边识别）、首字延迟 / RTF |
| 语音合成 TTS | PCM 流式实时播放、首包延迟(TTFB)/首声音/RTF、结果存为 WAV 整体回放与下载、历史记录 |
| 语音唤醒 | 实时监听麦克风，说出唤醒词才开始 ASR；唤醒词、容错、保持时长可配置 |
| 语音通话 | 选 ASR + TTS（+ 可选 LLM），类似豆包电话：VAD → ASR → LLM → 按句 TTS 流式播放，支持打断 |
| 模型管理 | 添加/编辑/测试连接、导入导出配置 |

## 快速开始

```bash
npm install
npm run mock        # 可选：本地模拟服务 http://127.0.0.1:9000（HTTP + FunASR WS），无需 GPU
npm run dev         # 前端 http://localhost:5173，代理服务 :8787
```

生产方式：`npm run build && npm start`，访问 http://localhost:8787。

> 麦克风需要安全上下文：请用 `localhost` 或 https 访问。远程使用时请前置 https 反向代理，或用 SSH 端口转发。

首次打开到「模型管理」添加模型。用 mock 联调时：

- ASR（vLLM 协议）：`http://127.0.0.1:9000`
- ASR（FunASR）：`ws://127.0.0.1:9000`
- TTS / LLM：`http://127.0.0.1:9000`

## 架构

```
浏览器 (React)  ──/api/proxy──▶  Node 代理  ──▶  你的 vLLM / vLLM-Omni (HTTP, SSE, 流式 PCM)
                ──/api/ws-proxy─▶            ──▶  你的 FunASR (WebSocket)
```

浏览器直连模型服务会遇到 CORS，并且 API Key 会暴露在页面里，所以所有请求经 `server/` 的轻量代理转发（流式透传，不缓冲）。
代理可以访问任意地址，**仅限可信环境使用**；公网部署请设置 `ALLOWED_HOSTS=host1,host2` 限制可访问的模型服务。
环境变量：`PORT`（默认 8787）、`HOST`、`ALLOWED_HOSTS`、`INSECURE_TLS=1`（自签名 wss/https）。

## 支持的协议

| 类型 | 协议 | 接口 |
| --- | --- | --- |
| ASR | `openai-transcriptions` | `POST /v1/audio/transcriptions`（multipart），`stream=true` 时解析 SSE |
| ASR | `funasr-ws` | FunASR runtime WebSocket（online / offline / 2pass，热词 JSON） |
| TTS | `openai-speech` | `POST /v1/audio/speech`，流式时 `response_format=pcm, stream=true` |
| LLM | `openai-chat` | `POST /v1/chat/completions`（SSE） |

每个模型都有「额外请求参数」JSON，会合并进请求（用于各模型特有参数，如参考音频、task type 等）。

设计细节（VAD / 声纹如何部署、能力声明、扩展点）见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录

```
server/   Node 代理 + mock 服务
web/src/
  asr/    ASR 适配器（openai / funasr-ws）
  tts/    TTS 流式合成与指标
  llm/    对话模型流式调用
  audio/  麦克风采集、重采样、VAD、PCM 流式播放、WAV 编码
  pages/  五个页面
```
