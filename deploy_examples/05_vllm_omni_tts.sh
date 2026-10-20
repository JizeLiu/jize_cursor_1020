#!/usr/bin/env bash
# =====================================================================
# 示例 5：用 vLLM-Omni 部署 TTS（OpenAI 兼容的 /v1/audio/speech，PCM 流式输出）
#
# 只是示例！vLLM-Omni 支持哪些 TTS 模型、启动参数是什么，以 vLLM-Omni 官方文档为准；
# 把下面带 <> 的地方换成你自己的值。
#
# 注意：平台请求 response_format=pcm、stream=true，浏览器边收边播。
# 采样率必须和模型真实输出一致（常见 24000），不一致会变声或变速。
# =====================================================================
set -euo pipefail

MODEL="<你的 TTS 模型，如 HuggingFace 名称或本地目录>"

vllm serve "$MODEL" \
  --omni \
  --port 8091

# ---- 在平台「模型管理」里这样填 ----
#   类型 TTS  | 协议 vLLM-Omni：/v1/audio/speech
#   服务地址  http://<这台机器的IP>:8091
#   PCM 采样率 24000（以模型实际输出为准）
#   默认音色  按模型支持的 voice 名称填，可留空
#
# ---- 部署后自测（把 PCM 流存成文件，再用 ffplay 听）----
#   curl http://127.0.0.1:8091/v1/audio/speech -H 'Content-Type: application/json' \
#     -d '{"input":"你好，这是一个测试","response_format":"pcm","stream":true}' -o out.pcm
#   ffplay -f s16le -ar 24000 -ac 1 out.pcm
