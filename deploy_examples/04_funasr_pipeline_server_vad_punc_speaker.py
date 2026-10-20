"""示例 4：FunASR Python 流水线 —— ASR + VAD + 标点 + CAM++ 声纹（说话人分离），对外是 HTTP 接口。

回答「声纹模型（CAM++）怎么加」：和 VAD、标点一样，不是在平台里单独添加，而是在你部署的
ASR 服务里把它们串起来。FunASR 官方 runtime 不带声纹，所以这里用 Python 的 AutoModel
自己搭一个，再包成和 vLLM 一样的 /v1/audio/transcriptions 接口，平台按「vLLM 协议」直接接入。

只是示例！没有在真实环境里跑过，funasr 版本不同参数可能略有差异。
运行：
    pip install funasr modelscope fastapi uvicorn python-multipart
    python 04_funasr_pipeline_server_vad_punc_speaker.py      # 监听 8002 端口

在平台「模型管理」里这样填：
    类型 ASR | 协议 vLLM：/v1/audio/transcriptions | 服务地址 http://<这台机器的IP>:8002
    model 名称 随便填（本脚本不看）| 热词传递方式 hotwords 字段，逗号分隔
    勾选：已带 VAD、已带标点、已带声纹/说话人
识别结果会带 segments（每句话的起止时间和说话人），ASR 页面的分句表会显示「SPK0 / SPK1」。
注意：这个接口只支持「非流式」，识别页请关闭「流式输出」。
"""

import os
import tempfile

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from funasr import AutoModel

# 四个模型串成一条流水线：
#   model      主识别模型（paraformer-zh 是带热词能力的 SeACo-Paraformer）
#   vad_model  fsmn-vad：先把长音频切成句子
#   punc_model ct-punc：给文字加标点
#   spk_model  cam++：给每一句话标说话人（SPK0 / SPK1 ...）
pipeline = AutoModel(
    model="paraformer-zh",
    vad_model="fsmn-vad",
    punc_model="ct-punc",
    spk_model="cam++",
    device=os.environ.get("DEVICE", "cuda:0"),  # 没有 GPU 改成 cpu
)

app = FastAPI()


@app.get("/v1/models")  # 平台「模型管理」的「检测是否在线」会请求这个地址
def models() -> dict:
    return {"data": [{"id": "funasr-pipeline"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    hotwords: str = Form(""),  # 平台每次请求带来的热词，逗号分隔
) -> dict:
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
    try:
        # FunASR 的热词是空格分隔的字符串
        result = pipeline.generate(input=tmp.name, batch_size_s=300, hotword=hotwords.replace(",", " "))[0]
    finally:
        os.unlink(tmp.name)

    # sentence_info 每项：{"text", "start"(毫秒), "end"(毫秒), "spk"}；平台要的是秒
    segments = [
        {"text": s["text"], "start": s["start"] / 1000, "end": s["end"] / 1000, "spk": s.get("spk")}
        for s in result.get("sentence_info", [])
    ]
    return {"text": result["text"], "segments": segments}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8002")))
