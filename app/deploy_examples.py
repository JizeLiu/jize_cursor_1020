"""「部署示例」页的数据：只是给用户看的示例脚本，平台不会执行它们。

脚本文件放在项目根目录的 deploy_examples/ 里，这里只负责登记标题和说明。
新增示例：把脚本放进 deploy_examples/，再往 EXAMPLES 里加一条即可。
"""

from pathlib import Path

EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "deploy_examples"

# tags 用来在页面上做标签；file 是 deploy_examples/ 下的文件名
EXAMPLES: list[dict] = [
    {
        "id": "fun-asr-nano",
        "title": "Fun-ASR-Nano（vLLM）",
        "summary": "vLLM 部署 ASR。自带标点；无 VAD / 声纹；热词用 hotwords 字段。",
        "tags": ["ASR", "vLLM", "标点"],
        "file": "01_vllm_fun_asr_nano.sh",
    },
    {
        "id": "qwen3-asr",
        "title": "Qwen3-ASR（vLLM）",
        "summary": "vLLM 部署 ASR。自带标点；热词写进 prompt 上下文。",
        "tags": ["ASR", "vLLM", "标点"],
        "file": "02_vllm_qwen3_asr.sh",
    },
    {
        "id": "funasr-runtime",
        "title": "FunASR runtime：ASR + VAD + 标点",
        "summary": "Docker 一条流水线：VAD 切句 → 流式/离线识别 → 标点 → ITN。VAD、标点模型就是在这里用参数加上的。",
        "tags": ["ASR", "FunASR", "VAD", "标点", "热词"],
        "file": "03_funasr_runtime_vad_punc.sh",
    },
    {
        "id": "funasr-pipeline",
        "title": "FunASR Python 流水线：VAD + 标点 + 声纹（CAM++）",
        "summary": "用 AutoModel 把 VAD、标点、CAM++ 声纹串起来，包成 HTTP 接口接入平台，分句表显示说话人。",
        "tags": ["ASR", "FunASR", "VAD", "标点", "声纹"],
        "file": "04_funasr_pipeline_server_vad_punc_speaker.py",
    },
    {
        "id": "vllm-omni-tts",
        "title": "TTS（vLLM-Omni）",
        "summary": "PCM 流式输出的语音合成服务，平台边收边播并统计首包耗时。",
        "tags": ["TTS", "vLLM-Omni"],
        "file": "05_vllm_omni_tts.sh",
    },
    {
        "id": "vllm-llm",
        "title": "对话大模型（vLLM）",
        "summary": "语音通话里负责「想」的 LLM，可选；不配则通话为复读模式。",
        "tags": ["LLM", "vLLM"],
        "file": "06_vllm_llm.sh",
    },
]


def load_examples() -> list[dict]:
    """返回带脚本内容（code 字段）的示例列表。"""
    return [{**e, "code": (EXAMPLES_DIR / e["file"]).read_text(encoding="utf-8")} for e in EXAMPLES]
