import { ASR_SAMPLE_RATE } from './decode';
import { concatInt16 } from './wav';

export interface VadOptions {
  /** 高于噪声底多少 dB 视为语音，越小越灵敏 */
  marginDb: number;
  /** 绝对能量下限 dBFS，避免极静环境下误触发 */
  minDb: number;
  /** 说话结束后静音多久才切段 */
  hangoverMs: number;
  /** 少于该时长的语音段被丢弃 */
  minSpeechMs: number;
  /** 段前保留的音频，避免吞字头 */
  prerollMs: number;
  /** 单段最长，超过强制切段 */
  maxSegmentMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  marginDb: 12,
  minDb: -50,
  hangoverMs: 700,
  minSpeechMs: 250,
  prerollMs: 300,
  maxSegmentMs: 30000,
};

const FRAME = ASR_SAMPLE_RATE / 50; // 20ms

export interface VadEvents {
  onSpeechStart?: () => void;
  onSegment?: (pcm: Int16Array, durationMs: number) => void;
  onLevel?: (db: number, speaking: boolean) => void;
}

/**
 * 轻量自适应能量 VAD，运行在浏览器端。
 * 仅用于「语音唤醒」「通话」这类需要客户端切分的场景；
 * 如果 ASR 服务端已带 VAD（如 FunASR 的 fsmn-vad），在 ASR 体验页直接交给服务端即可。
 */
export class EnergyVad {
  private opts: VadOptions;
  private carry = new Int16Array(0);
  private noiseDb = -60;
  private speaking = false;
  private voicedRun = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private segment: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  private prerollFrames: number;

  constructor(
    private ev: VadEvents,
    opts: Partial<VadOptions> = {},
  ) {
    this.opts = { ...DEFAULT_VAD, ...opts };
    this.prerollFrames = Math.ceil(this.opts.prerollMs / 20);
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  push(pcm: Int16Array): void {
    const data = this.carry.length ? concatInt16([this.carry, pcm]) : pcm;
    let off = 0;
    for (; off + FRAME <= data.length; off += FRAME) this.frame(data.subarray(off, off + FRAME).slice());
    this.carry = data.slice(off);
  }

  /** 强制结束当前语音段（如停止监听时）。 */
  flush(): void {
    if (this.speaking) this.endSegment();
    this.carry = new Int16Array(0);
  }

  private frame(f: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length) / 32768;
    const db = 20 * Math.log10(rms + 1e-9);
    const threshold = Math.max(this.opts.minDb, this.noiseDb + this.opts.marginDb);
    const voiced = db > threshold;

    if (!this.speaking) {
      this.noiseDb = this.noiseDb * 0.95 + Math.min(db, -20) * 0.05;
      this.preroll.push(f);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= 3) {
        this.speaking = true;
        this.silenceMs = 0;
        this.speechMs = this.voicedRun * 20;
        this.segment = [...this.preroll];
        this.preroll = [];
        this.ev.onSpeechStart?.();
      }
    } else {
      this.segment.push(f);
      if (voiced) {
        this.silenceMs = 0;
        this.speechMs += 20;
      } else {
        this.silenceMs += 20;
      }
      const totalMs = this.segment.length * 20;
      if (this.silenceMs >= this.opts.hangoverMs || totalMs >= this.opts.maxSegmentMs) this.endSegment();
    }
    this.ev.onLevel?.(db, this.speaking);
  }

  private endSegment(): void {
    const pcm = concatInt16(this.segment);
    const speechMs = this.speechMs;
    this.speaking = false;
    this.voicedRun = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.segment = [];
    this.preroll = [];
    if (speechMs >= this.opts.minSpeechMs) this.ev.onSegment?.(pcm, (pcm.length / ASR_SAMPLE_RATE) * 1000);
  }
}
