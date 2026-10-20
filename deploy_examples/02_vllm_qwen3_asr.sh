#!/usr/bin/env bash
# =====================================================================
# 示例 2：用 vLLM 部署 Qwen3-ASR（ASR，OpenAI 兼容的 /v1/audio/transcriptions）
#
# 只是示例！模型名和需要的 vLLM 版本请以 Qwen3-ASR 官方文档为准。
#
# 该模型的特点：
#   - 自带标点；没有 VAD、没有声纹
#   - 热词：没有专门的热词字段，把词写进 prompt（上下文）里，平台会自动这样传
# =====================================================================
set -euo pipefail

# 音频相关依赖（解码音频用）
pip install "vllm[audio]"

vllm serve Qwen/Qwen3-ASR-1.7B \
  --served-model-name Qwen/Qwen3-ASR-1.7B \
  --port 8000

# ---- 在平台「模型管理」里这样填 ----
#   类型 ASR  | 协议 vLLM：/v1/audio/transcriptions
#   服务地址  http://<这台机器的IP>:8000
#   model 名称 Qwen/Qwen3-ASR-1.7B
#   热词传递方式 prompt 字段，作为上下文
#   勾选：支持流式输出、已带标点
