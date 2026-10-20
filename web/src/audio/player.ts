import { bytesToInt16, concatInt16, int16ToFloat32 } from './wav';

/**
 * 流式 PCM(s16le, 单声道) 播放器：边收边播，并保留全部 PCM 以便导出 WAV。
 * 多段（如多句 TTS）可以共用同一个播放器，连续排队播放。
 */
export class PcmStreamPlayer {
  private ctx: AudioContext;
  private nextTime = 0;
  private leftover: Uint8Array | null = null;
  private pcmParts: Int16Array[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private ended = false;
  private stopped = false;
  private idleResolvers: Array<() => void> = [];
  /** 第一个音频块被调度播放的 performance.now() 时间 */
  firstPlayAt: number | null = null;
  onFirstPlay?: (at: number) => void;

  constructor(
    public readonly sampleRate: number,
    private prebufferSec = 0.06,
  ) {
    this.ctx = new AudioContext({ sampleRate });
    void this.ctx.resume();
  }

  get outputLatencyMs(): number {
    return ((this.ctx.baseLatency || 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)) * 1000;
  }

  push(bytes: Uint8Array): void {
    if (this.stopped || bytes.length === 0) return;
    let data = bytes;
    if (this.leftover) {
      const merged = new Uint8Array(this.leftover.length + bytes.length);
      merged.set(this.leftover);
      merged.set(bytes, this.leftover.length);
      data = merged;
      this.leftover = null;
    }
    if (data.length % 2 === 1) {
      this.leftover = data.slice(data.length - 1);
      data = data.subarray(0, data.length - 1);
    }
    if (data.length === 0) return;
    const pcm = bytesToInt16(data);
    this.pcmParts.push(pcm);
    this.schedule(pcm);
  }

  private schedule(pcm: Int16Array): void {
    const floats = int16ToFloat32(pcm);
    const buffer = this.ctx.createBuffer(1, floats.length, this.sampleRate);
    buffer.copyToChannel(floats, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.005) this.nextTime = now + this.prebufferSec;
    src.start(this.nextTime);
    if (this.firstPlayAt === null) {
      this.firstPlayAt = performance.now();
      this.onFirstPlay?.(this.firstPlayAt);
    }
    this.nextTime += buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.checkIdle();
    };
  }

  private checkIdle(): void {
    if (this.sources.size === 0 && (this.ended || this.stopped)) {
      const rs = this.idleResolvers;
      this.idleResolvers = [];
      rs.forEach((r) => r());
    }
  }

  /** 不会再有新数据；返回的 Promise 在已排队音频播放完毕后 resolve。 */
  end(): Promise<void> {
    this.ended = true;
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
      this.checkIdle();
    });
  }

  /** 立即停止播放（打断）。 */
  stop(): void {
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.checkIdle();
  }

  get isPlaying(): boolean {
    return this.sources.size > 0;
  }

  getPcm(): Int16Array {
    return concatInt16(this.pcmParts);
  }

  get durationSec(): number {
    return this.pcmParts.reduce((n, p) => n + p.length, 0) / this.sampleRate;
  }

  dispose(): void {
    this.stop();
    void this.ctx.close();
  }
}
