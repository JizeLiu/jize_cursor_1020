import { MicCapture } from './mic';
import { EnergyVad, type VadEvents, type VadOptions } from './vad';

/** 麦克风 + 客户端 VAD：持续监听，按语音段回调。 */
export class VadListener {
  private mic = new MicCapture();
  private vad?: EnergyVad;

  async start(events: VadEvents, opts?: Partial<VadOptions>): Promise<void> {
    this.vad = new EnergyVad(events, opts);
    await this.mic.start((pcm) => this.vad?.push(pcm));
  }

  get speaking(): boolean {
    return this.vad?.isSpeaking ?? false;
  }

  stop(): void {
    this.mic.stop();
    this.vad?.flush();
    this.vad = undefined;
  }
}
