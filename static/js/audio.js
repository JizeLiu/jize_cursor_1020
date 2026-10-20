// 浏览器里只做两件事：把麦克风变成 16k PCM（MicStream），把收到的 PCM 播出来（PcmPlayer）。
// 所有识别、合成、对话逻辑都在 Python 后端。

const WORKLET_CODE = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);
`;

const TARGET_RATE = 16000;

/** 采集麦克风；回调 onPcm(ArrayBuffer)：16kHz 单声道 16bit 小端 PCM。 */
export class MicStream {
  async start(onPcm) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('无法使用麦克风：请通过 https 或 localhost 访问本页面');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    // 浏览器采样率通常是 44.1k/48k，这里线性插值降到 16k
    const ratio = this.ctx.sampleRate / TARGET_RATE;
    let position = 0;
    let last = 0;
    this.node = new AudioWorkletNode(this.ctx, 'capture');
    this.node.port.onmessage = (event) => {
      const input = event.data;
      const out = [];
      while (Math.floor(position) + 1 < input.length) {
        const i = Math.floor(position);
        const frac = position - i;
        const a = i < 0 ? last : input[i];
        out.push(a * (1 - frac) + input[i + 1] * frac);
        position += ratio;
      }
      position -= input.length;
      last = input[input.length - 1];
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-1, Math.min(1, out[i])) * 0x7fff;
      if (pcm.length) onPcm(pcm.buffer);
    };
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
  }

  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.node = this.source = this.stream = this.ctx = null;
  }
}

/** 流式播放 PCM（16bit 单声道小端）：push 一块就排进播放队列一块。 */
export class PcmPlayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.ctx = new AudioContext({ sampleRate });
    this.ctx.resume();
    this.nextTime = 0;
    this.leftover = null; // 上一块末尾多出的 1 个字节（一个采样是 2 字节，可能被拆在两块里）
    this.sources = new Set();
    this.firstPlayAt = null; // 第一个采样开始播放的时间（performance.now）
  }

  push(arrayBuffer) {
    let bytes = new Uint8Array(arrayBuffer);
    if (this.leftover) {
      const merged = new Uint8Array(this.leftover.length + bytes.length);
      merged.set(this.leftover);
      merged.set(bytes, this.leftover.length);
      bytes = merged;
      this.leftover = null;
    }
    if (bytes.length % 2) {
      this.leftover = bytes.slice(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (!bytes.length) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    // 如果队列已经播空了，留 60ms 缓冲再开始，避免一开始就卡顿
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.005) this.nextTime = now + 0.06;
    source.start(this.nextTime);
    this.firstPlayAt ??= performance.now();
    this.nextTime += buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /** 立即停止所有声音（打断时用），播放器之后还能继续 push。 */
  clear() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
    this.leftover = null;
  }

  /** 等排队的声音播完。 */
  async finished() {
    while (this.sources.size) await new Promise((r) => setTimeout(r, 50));
  }

  close() {
    this.clear();
    this.ctx.close();
  }
}

/** 16k PCM(ArrayBuffer 数组) 拼成 WAV Blob，用于回放刚录的音。 */
export function pcmToWavBlob(chunks, sampleRate = TARGET_RATE) {
  const dataLength = chunks.reduce((n, c) => n + c.byteLength, 0);
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const text = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataLength, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, dataLength, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

/** 一帧 PCM 的音量（dBFS），给录音页的音量条用。 */
export function pcmLevelDb(arrayBuffer) {
  const samples = new Int16Array(arrayBuffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(sum / (samples.length || 1)) / 32768 + 1e-6);
}
