# 交接文档（给明天在电脑上接手的你）

这份文档回答三件事：**现在做到了什么、明天在电脑上怎么跑起来、出了问题去哪里看**。
更细的设计说明在 `docs/DESIGN.md`，日常使用说明在 `README.md`。

---

## 1. 一句话总结

一个「语音模型体验平台」：你在自己的 GPU 机器上用 vLLM / vLLM-Omni / FunASR 部署好模型，
在平台里**登记「名称 + API 地址」**，然后在四个功能页面里**只按名称选模型**来体验。

| 功能 | 页面 | 做了什么 |
| --- | --- | --- |
| ASR 识别 | 语音识别 | 选模型；页面手动配热词；流式/非流式；上传文件或麦克风录制/停止 |
| TTS 合成 | 语音合成 | 输入文字，PCM 实时边收边播；首包耗时大字显示；结果存 WAV，可回放/下载 |
| 语音唤醒 | 语音唤醒 | 页面自定义唤醒词（可多个、监听中可改）；实时监听，说出唤醒词才开始识别 |
| 语音通话 | 语音通话 | 选 ASR + TTS（+可选 LLM）；像打电话；AI 说话时你开口即可打断 |
| 模型登记 | 模型管理 | 名称 + 地址；测试连接；检测是否在线（含延迟） |
| 部署参考 | 部署示例 | 只读的示例脚本：怎么部署各类模型、怎么给 ASR 配 VAD/标点/声纹 |

代码在 GitHub 分支 `cursor/asr-tts-playground-3ff6`（PR #1）。

---

## 2. 重要：目前验证到什么程度

- **已验证**：用 `mock_server.py`（模拟的模型服务）把所有流程跑通——自动测试 36 项通过，
  另外在真实 Chrome（假麦克风）里跑过完整的页面操作。
- **没有验证**：**还没有连过真实的 vLLM / vLLM-Omni / FunASR**。所以明天接真实模型时，
  可能遇到「接口字段和模拟的不完全一致」的小问题（见第 7 节排错）。这是最可能需要调整的地方。
- **`deploy_examples/` 里的部署命令**是按文档和经验写的示例，**没有在真实机器上执行过**，
  模型名、版本号请以各项目官方文档为准。
- 浏览器端到端测试脚本没有放进仓库（依赖 Node 和本机路径），仓库里只有 Python 测试。

---

## 3. 明天在电脑上怎么跑起来（照着做）

需要：Python 3.11+、ffmpeg（只有「上传音频文件」识别时用来解码）、Chrome。

```bash
# 1) 拿代码
git clone https://github.com/JizeLiu/jize_cursor_1020.git
cd jize_cursor_1020
git checkout cursor/asr-tts-playground-3ff6      # 如果 PR 已合并，直接用 main

# 2) 装依赖
pip install -r requirements.txt

# 3) 先跑自动测试（确认环境没问题，约 15 秒）
python -m pytest

# 4) 没有真实模型时：先用模拟服务把平台玩一遍
python mock_server.py          # 终端 A：模拟模型服务，端口 9000
python -m app                  # 终端 B：启动平台，端口 8787
```

浏览器打开 <http://localhost:8787>。

**用模拟服务体验的步骤**：
1. 点「模型管理」，点上方「+ xxx」模板按钮，地址改成 `http://127.0.0.1:9000`
   （FunASR 那个改成 `ws://127.0.0.1:9000/`），保存。依次加一个 ASR、一个 TTS、一个 LLM。
2. 状态列显示「● 在线」后，回到首页逛四个功能。
3. 模拟服务的识别结果是固定的一句话（会回显你发的热词），TTS 返回的是一段音调，
   目的是测流程，不是测效果。

> 麦克风只能在 `localhost` 或 https 下使用。如果平台跑在远程服务器上，请用 SSH 端口转发
> （`ssh -L 8787:localhost:8787 用户@服务器`），再访问 `localhost:8787`。
>
> 平台**默认只允许本机访问**（127.0.0.1）。想让局域网里的其他电脑访问：`HOST=0.0.0.0 python -m app`。
> 平台没有登录鉴权，API Key 明文存在 `data/models.json`，只在可信内网这样做。
>
> Windows：命令相同，设置环境变量用 `set HOST=0.0.0.0` 再 `python -m app`（PowerShell 用 `$env:HOST="0.0.0.0"`）；
> ffmpeg 需要自己下载并加入 PATH。

### 在 Linux 服务器上跑（推荐方式）

开发和测试就是在 Ubuntu 24.04 + Python 3.12 上做的，Linux 是最稳的环境。

```bash
sudo apt install -y python3-venv ffmpeg tmux      # CentOS 用 yum 装 python3 / ffmpeg / tmux
git clone https://github.com/JizeLiu/jize_cursor_1020.git && cd jize_cursor_1020
git checkout cursor/asr-tts-playground-3ff6
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest                                  # 先确认环境没问题
tmux new -s platform                              # 放进 tmux，断开 SSH 也不会停
python -m app                                     # 平台监听 127.0.0.1:8787
```

然后在**你自己的电脑**上开一个终端做端口转发，浏览器访问 <http://localhost:8787>：

```bash
ssh -L 8787:localhost:8787 用户@服务器IP
```

要点：
- **Python 要 3.10 以上，建议 3.11/3.12**（用到了 3.10 才有的语法）。服务器自带的 3.8/3.9 不行，用 conda 或 pyenv 装新的。
- 平台和 vLLM / FunASR 在同一台服务器时，「模型管理」里地址直接填 `http://127.0.0.1:端口`（FunASR 填 `ws://127.0.0.1:端口`）。
- 用 SSH 转发访问时浏览器看到的是 `localhost`，麦克风可以直接用；如果直接用服务器 IP 访问（`HOST=0.0.0.0`），浏览器会因为不是 https 而禁用麦克风。
- 防火墙/云服务器安全组不需要开放 8787（SSH 转发走的是 22 端口）。

---

## 4. 接真实模型：推荐顺序

端口约定（都可以改，登记时填实际的）：

| 服务 | 端口 | 登记时的协议 |
| --- | --- | --- |
| 平台本身 | 8787 | — |
| vLLM ASR（Fun-ASR-Nano / Qwen3-ASR） | 8000 | vLLM：/v1/audio/transcriptions |
| 对话 LLM（vLLM） | 8001 | vLLM：/v1/chat/completions |
| FunASR pipeline（带声纹，示例 4） | 8002 | vLLM：/v1/audio/transcriptions |
| vLLM-Omni TTS | 8091 | vLLM-Omni：/v1/audio/speech |
| FunASR runtime（Docker） | 10096 | FunASR WebSocket |

**建议一个一个来，每接一个就测一个**：

1. 打开平台的「部署示例」页，选一个示例，复制脚本到 GPU 机器上，按注释改 `<...>` 的地方，启动。
2. 在服务器上用示例末尾的 `curl` 先自测，确认服务本身是通的。
3. 在平台「模型管理」登记（示例脚本末尾有「在平台这样填」的清单），点「检测」确认「● 在线」。
4. 到对应功能页试：先 ASR（传一段短 wav），再 TTS，再唤醒，最后通话。

登记时每一项的含义：

| 字段 | 含义 |
| --- | --- |
| 名称 | 你自己起的，功能页下拉框里显示它；同一类型不能重名 |
| 协议 | 决定平台用哪种方式调用这个服务 |
| 服务地址 | `http://IP:端口`（末尾带不带 `/v1` 都行）；FunASR 填 `ws://IP:端口` |
| model 名称 | 请求里的 model 字段，要和 `vllm serve --served-model-name` 一致 |
| 热词传递方式 | 见下表 |
| 部署时已带 VAD/标点/声纹 | 只是「声明」，只影响页面提示，平台不会替你启用 |
| PCM 采样率（TTS） | 必须和模型真实输出一致，否则声音变快/变慢 |
| 额外请求参数 | JSON，原样合并进请求，放各模型特有参数 |

热词怎么传（**热词在页面里手动配，每次请求都会带上，不需要部署时配置**）：

| 模型 | 热词传递方式 | 说明 |
| --- | --- | --- |
| Fun-ASR-Nano（vLLM） | hotwords 字段 | 逗号分隔 |
| Qwen3-ASR（vLLM） | prompt 字段 | 热词写进上下文 |
| Paraformer（FunASR） | FunASR JSON | `{"词": 权重}`；必须部署 SeACo / contextual 版本才生效 |

---

## 5. 关于 VAD / 标点 / 声纹（你问过的）

**它们不是在平台里单独添加的，而是在部署 ASR 服务时一起配好。** 平台只看到一个地址。

- 纯 vLLM 部署的 Fun-ASR-Nano / Qwen3-ASR：自带标点，**没有** VAD 和声纹。
- FunASR runtime（Docker）：用启动参数加上 VAD、标点、ITN（示例 3）。
- 想要声纹（CAM++ 说话人）：FunASR 官方 runtime 不带，用 Python `AutoModel` 自己搭
  （示例 4，包成 HTTP 接口，识别结果带 `spk`，页面分句表会显示 SPK0/SPK1）。
- 平台里「唤醒」和「通话」用的是平台**自带的简单音量 VAD**（`app/vad.py`），
  不依赖服务端有没有 VAD。

还没有做：独立的声纹验证（只响应某个人的声音）。

---

## 6. 代码地图：想改什么，去哪里

整个项目 = **Python 后端做所有逻辑** + **很薄的网页**（只负责麦克风采集和播放声音）。
网页是原生 HTML/JS，**不需要 Node、不需要编译**，改完刷新浏览器就生效；改 Python 要重启 `python -m app`。

```
app/                         Python 后端（FastAPI）
  main.py                    所有接口一览（先看这个文件）
  config.py                  模型配置的数据结构 + 保存到 data/models.json
  presets.py                 「模型管理」里的一键模板
  deploy_examples.py         「部署示例」页的清单
  asr.py                     调用 ASR（vLLM HTTP / FunASR WebSocket 两种协议）
  asr_routes.py              ASR 页的两个入口：上传文件、麦克风
  tts.py                     调用 TTS（PCM 流）
  llm.py                     调用对话 LLM（流式）
  hotwords.py                热词按模型要求的格式拼进请求
  vad.py                     能量 VAD（切句子、检测开口）
  wake.py / ws_wake.py       唤醒词匹配 / 语音唤醒流程
  ws_call.py                 语音通话流程（含打断）
  ws_utils.py / http_utils.py / audio.py   小工具
static/                      网页
  index.html                 所有页面的结构（每个 <section id="page-xxx"> 是一页）
  style.css                  样式
  js/main.js                 页面切换、首页状态
  js/common.js               公共函数：调接口、模型下拉框、热词组件
  js/audio.js                麦克风采集 + PCM 播放（浏览器唯一的「难」代码）
  js/asr.js tts.js wake.js call.js models.js deploy.js    各页面
deploy_examples/             示例部署脚本（只读展示，不会被执行）
mock_server.py               模拟模型服务（没有 GPU 时联调用）
tests/                       自动测试
docs/DESIGN.md               设计说明；docs/HANDOFF.md 就是本文
data/                        运行时生成：models.json（模型登记）、outputs/（TTS 的 WAV）。不进 git
```

常见修改：

| 想做的事 | 改哪里 |
| --- | --- |
| 加一个新的模型模板按钮 | `app/presets.py` |
| 加一个新的部署示例 | 脚本放进 `deploy_examples/`，在 `app/deploy_examples.py` 登记一条 |
| 调整「打断」灵敏度 | `app/ws_call.py` 里的 `BARGE_IN_MS`（默认 240ms） |
| 调整 VAD 灵敏度/静音多久算说完 | `app/vad.py` 的 `EnergyVad` 参数（`hangover_ms` 等） |
| 某个模型热词传法不一样 | `app/hotwords.py`，并在 `app/config.py` 的 `HotwordMode` 加一种 |
| 接一个新协议的模型 | `app/asr.py`（或 tts/llm）加调用函数，`config.py` 的 `protocol` 加一项 |
| 改界面文字/布局 | `static/index.html`、`static/style.css` |

---

## 7. 出问题怎么排查

先看**页面上的红色错误提示**，它会带上模型地址和对方返回的内容。再看运行 `python -m app` 的终端。

| 现象 | 可能原因 / 处理 |
| --- | --- |
| 模型管理里是「○ 离线」 | 地址/端口不对、服务没起来、防火墙；平台所在机器要能访问该地址。表格里有具体报错 |
| 「在线」但识别返回 4xx/5xx | `model 名称`和 `--served-model-name` 不一致；或接口字段与模拟服务不同——看红色提示里对方的返回内容 |
| 识别结果为空 | 音频太短/太安静；或 vLLM 版本返回结构不同（看 `app/asr.py` 的解析部分） |
| 上传音频报「需要安装 ffmpeg」 | `apt install ffmpeg` / `brew install ffmpeg` |
| 点麦克风没反应 | 必须用 `localhost` 或 https 访问；浏览器要允许麦克风权限 |
| TTS 声音变快/变慢/杂音 | 登记里的「PCM 采样率」与模型实际输出不一致 |
| 热词没效果 | 热词只是「偏置」不是强制替换；确认「热词传递方式」选对；Paraformer 要 SeACo 版本 |
| 唤醒词总是不触发 | ASR 可能识别成同音字：把常见误识别写法也加成唤醒词，或调大「模糊匹配容错」 |
| 通话时 AI 自己打断自己 | 用扬声器外放，AI 声音被麦克风收到；请戴耳机，或关闭「允许打断」 |
| 通话回复很慢 | 看「单轮延迟」四个指标，哪一项大就是哪个模型慢（ASR / LLM 首字 / TTS 首包） |

---

## 8. 你可能会问的几个问题（提前写好答案）

- **所有功能是不是通过模型名字调用？** 是。网页只发「模型 id」，地址永远由后端从「模型管理」里查；
  在模型管理改地址，所有功能立刻生效。
- **热词要不要部署时配置？** 不需要。页面里手动配，每次请求都带上。
- **打断是怎么做到的？** 你连续说话超过约 0.24 秒，后端取消 LLM/TTS 请求并通知浏览器立刻停止播放，
  你那句话作为下一轮的输入。可在通话页取消勾选关闭。
- **为什么不用 Gradio？** Gradio 做不了通话需要的「边听边播 + 随时打断」、精确首包计时、持续监听唤醒。
- **TTS「首包耗时」怎么算的？** 从点击合成到浏览器收到第一块音频数据的时间。
- **数据存在哪？** `data/models.json`（模型登记）、`data/outputs/`（TTS 生成的 WAV）；热词和唤醒词存在浏览器 localStorage。
- **换了电脑模型登记会丢吗？** 会，`data/` 不进 git。需要的话把 `data/models.json` 拷过去。

---

## 9. 已知限制 & 后续可以做的

- vLLM 类 ASR 的麦克风「流式」是后端 VAD 切句后一句一句出字（说完停顿约 0.7 秒才出），不是逐字出字；逐字只有 FunASR 支持。
- 唤醒基于「ASR 转文字再匹配」，待机时的语音也会发给 ASR；同音字靠加误识别写法或模糊匹配兜底。
- 通话的打断靠能量 VAD + 浏览器回声消除，外放时仍可能误触发（要彻底解决需服务端回声消除）。
- 能量 VAD 在嘈杂环境下不如专用 VAD 模型；可以换成 FunASR 的 fsmn-vad / silero-vad（改 `app/vad.py` 即可，接口不变）。
- 没有做独立声纹验证、没有用户登录/权限（平台默认只给自己用，别直接暴露到公网）。
- 可选的下一步：接上真实模型后根据返回格式微调解析；把浏览器端到端测试放进仓库；加一个对比页（同一段音频同时发给多个 ASR 看结果）。

---

## 10. 常用命令速查

```bash
python -m pytest                       # 自动测试（36 项）
python -m pytest -k barge              # 只跑某类测试（这里是打断）
python -m app                          # 启动平台（PORT=9999 python -m app 可改端口）
RELOAD=1 python -m app                 # 改 Python 代码后自动重启（开发时方便）
python mock_server.py                  # 启动模拟模型服务
python -m ruff check --select E,F,W --ignore E501 .   # 代码检查（需 pip install ruff）
```
