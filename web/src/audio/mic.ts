import { ASR_SAMPLE_RATE, StreamResampler } from './decode';
import { float32ToInt16 } from './wav';

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);
`;

/** 采集麦克风，回调 16kHz 单声道 Int16 PCM 帧。 */
export class MicCapture {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;

  async start(onPcm: (pcm: Int16Array) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境无法使用麦克风：请通过 https 或 localhost 访问本页面');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const resampler = new StreamResampler(this.ctx.sampleRate, ASR_SAMPLE_RATE);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const out = resampler.process(e.data);
      if (out.length) onPcm(float32ToInt16(out));
    };
    this.source.connect(this.node);
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.ctx = undefined;
  }
}
