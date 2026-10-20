import { float32ToInt16 } from './wav';

export const ASR_SAMPLE_RATE = 16000;

/** 把任意浏览器可解码的音频文件转成 16kHz 单声道 Int16 PCM。 */
export async function decodeToPcm16k(file: Blob): Promise<Int16Array> {
  const arr = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arr);
  } catch {
    throw new Error('无法解码该音频文件，请换成 wav / mp3 / m4a / ogg / flac 等常见格式');
  } finally {
    void ctx.close();
  }
  const length = Math.ceil(decoded.duration * ASR_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, ASR_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return float32ToInt16(rendered.getChannelData(0));
}

/** 流式线性重采样，跨块保持连续（用于把麦克风 44.1/48kHz 降到 16kHz）。 */
export class StreamResampler {
  private pos = 0;
  private last = 0;

  constructor(
    private inRate: number,
    private outRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate || input.length === 0) return input;
    const ratio = this.inRate / this.outRate;
    const out: number[] = [];
    while (Math.floor(this.pos) + 1 < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.last : input[i];
      out.push(a * (1 - frac) + input[i + 1] * frac);
      this.pos += ratio;
    }
    this.pos -= input.length;
    this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}
