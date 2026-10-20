#!/usr/bin/env bash
# =====================================================================
# 示例 1：用 vLLM 部署 Fun-ASR-Nano（ASR，OpenAI 兼容的 /v1/audio/transcriptions）
#
# 只是示例！vLLM 对 Fun-ASR-Nano 的支持方式（官方版本 / 适配分支）以你实际使用的
# 版本文档为准，把下面带 <> 的地方换成你自己的值。
#
# 该模型的特点：
#   - 自带标点输出，不需要另外部署标点模型
#   - 没有 VAD、没有声纹：长音频请先切分（平台的「语音唤醒/通话」自带简单 VAD，不受影响）
#   - 热词：请求里带 hotwords 字段（逗号分隔），不需要部署时配置
# =====================================================================
set -euo pipefail

MODEL_PATH="<Fun-ASR-Nano 权重目录或 HuggingFace 名称>"
PORT=8000

vllm serve "$MODEL_PATH" \
  --served-model-name fun-asr-nano \
  --trust-remote-code \
  --port "$PORT"

# ---- 在平台「模型管理」里这样填 ----
#   类型 ASR  | 协议 vLLM：/v1/audio/transcriptions
#   服务地址  http://<这台机器的IP>:8000
#   model 名称 fun-asr-nano            （必须和 --served-model-name 一致）
#   热词传递方式 hotwords 字段，逗号分隔
#   勾选：支持流式输出、已带标点
#
# ---- 部署后自测（应返回 JSON，里面有 text）----
#   curl http://127.0.0.1:8000/v1/audio/transcriptions \
#     -F file=@test.wav -F model=fun-asr-nano -F hotwords="阿里巴巴,通义千问"
