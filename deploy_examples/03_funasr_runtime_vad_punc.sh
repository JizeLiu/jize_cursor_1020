#!/usr/bin/env bash
# =====================================================================
# 示例 3：FunASR 官方 runtime（Docker）—— ASR + VAD + 标点，一个 WebSocket 地址对外
#
# 回答「VAD / 标点模型要怎么加」：它们不是平台里单独添加的，而是在启动 FunASR 服务时
# 用参数一起指定，服务内部串成流水线（VAD 切句 -> ASR -> 标点），平台只看到一个地址。
#
# 只是示例！镜像版本号、模型名称会随 FunASR 版本变化，
# 以 FunASR 仓库 runtime/readme 为准。下面的结构和参数名是稳定的。
# =====================================================================
set -euo pipefail

# ---------- 第 1 步：启动容器（宿主机 10096 -> 容器 10095）----------
mkdir -p ./funasr-runtime-resources/models
docker run -p 10096:10095 -it --privileged=true \
  -v "$PWD/funasr-runtime-resources/models:/workspace/models" \
  registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.12
# 下面的命令都在容器里执行：

# ---------- 第 2 步（容器内）：启动 2pass 服务 ----------
# cd FunASR/runtime
# nohup bash run_server_2pass.sh \
#   --download-model-dir /workspace/models \
#   --vad-dir    damo/speech_fsmn_vad_zh-cn-16k-common-onnx \
#   --model-dir  damo/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx \
#   --online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx \
#   --punc-dir   damo/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx \
#   --itn-dir    thuduyuxin/fst_itn_zh \
#   --hotword    /workspace/models/hotwords.txt \
#   > log.txt 2>&1 &
#
# 各参数的作用：
#   --vad-dir          VAD 模型（fsmn-vad）：把长音频/连续语音切成一句一句
#   --model-dir        离线（整句）识别模型，句尾用它纠正
#   --online-model-dir 流式识别模型，边说边出字
#   --punc-dir         标点模型：给识别结果加标点
#   --itn-dir          逆文本规范化：「二零二四年」->「2024年」
#   --hotword          服务端默认热词文件，每行「词 权重」，如：阿里巴巴 20
#                      （平台页面里配的热词会随每次请求发送，优先于这个文件）
#
# 想让热词真正生效：--model-dir 要换成带热词的 SeACo/contextual 版本，例如
#   damo/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx
#
# 怎么确认服务起来了：容器里 tail -f log.txt，看到监听 10095 端口即可。

# ---- 在平台「模型管理」里这样填 ----
#   类型 ASR  | 协议 FunASR WebSocket
#   服务地址  ws://<这台机器的IP>:10096
#   FunASR 实时模式 2pass（实时 + 句尾纠正）
#   热词传递方式 FunASR：{"词": 权重} JSON
#   勾选：支持流式输出、已带 VAD、已带标点
