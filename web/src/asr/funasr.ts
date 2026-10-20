import { authHeaders, parseExtra, proxiedWsUrl } from '../lib/proxy';
import type { AsrResult, AsrSegment, Hotword, ModelConfig } from '../lib/types';

export interface FunAsrOptions {
  hotwords: Hotword[];
  /** 覆盖模型默认模式 */
  mode?: 'online' | 'offline' | '2pass';
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
}

export interface LiveSession {
  sendPcm(pcm: Int16Array): void;
  /** 告知服务端说话结束并等待最终结果 */
  finish(): Promise<AsrResult>;
  close(): void;
}

function parseChunkSize(s?: string): number[] {
  const arr = (s || '5,10,5').split(',').map((x) => Number(x.trim()));
  return arr.length === 3 && arr.every((n) => Number.isFinite(n) && n > 0) ? arr : [5, 10, 5];
}

function toSegments(stamp: unknown): AsrSegment[] | undefined {
  if (!Array.isArray(stamp)) return undefined;
  return stamp.map((s: any) => ({
    text: s.text_seg ?? s.text ?? '',
    start: typeof s.start === 'number' ? s.start / 1000 : undefined,
    end: typeof s.end === 'number' ? s.end / 1000 : undefined,
    spk: typeof s.spk === 'number' ? s.spk : undefined,
  }));
}

/**
 * FunASR runtime WebSocket 协议。
 * 首包 JSON 配置 → 持续发 16k s16le PCM → {is_speaking:false} 结束。
 * 2pass：*-online 为实时低延迟结果，*-offline 为句尾纠正后的最终结果。
 */
export async function openFunAsrSession(model: ModelConfig, opts: FunAsrOptions): Promise<LiveSession> {
  const mode = opts.mode ?? model.funasrMode ?? '2pass';
  const ws = new WebSocket(proxiedWsUrl(model.baseUrl, authHeaders(model)));
  ws.binaryType = 'arraybuffer';

  const t0 = performance.now();
  let firstTokenMs: number | undefined;
  let committed = '';
  let partial = '';
  let segments: AsrSegment[] = [];
  let finalResolve!: (r: AsrResult) => void;
  let finalReject!: (e: Error) => void;
  const finalPromise = new Promise<AsrResult>((res, rej) => {
    finalResolve = res;
    finalReject = rej;
  });
  let finishing = false;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    finalResolve({ text: committed + partial, segments: segments.length ? segments : undefined, firstTokenMs, totalMs: performance.now() - t0 });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const text: string = msg.text ?? '';
    if (text) firstTokenMs ??= performance.now() - t0;
    const m: string = msg.mode ?? mode;
    if (m === '2pass-online' || m === 'online') {
      partial += text;
    } else if (m === '2pass-offline' || m === 'offline') {
      committed += text;
      partial = '';
      const segs = toSegments(msg.stamp_sents);
      if (segs) segments = segments.concat(segs);
    }
    opts.onPartial?.(committed + partial);
    if (msg.is_final && finishing) {
      settle();
      ws.close();
    }
  };
  let opened = false;
  ws.onerror = () => {
    if (opened && !settled) {
      settled = true;
      finalReject(new Error('FunASR WebSocket 连接出错'));
    }
  };
  ws.onclose = (ev) => {
    if (!opened || settled) return;
    if (finishing) settle();
    else {
      settled = true;
      finalReject(new Error(ev.reason || `FunASR 连接已关闭 (${ev.code})`));
    }
  };
  opts.signal?.addEventListener('abort', () => ws.close());

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      opened = true;
      resolve();
    });
    ws.addEventListener('close', (ev) => {
      if (!opened) reject(new Error(ev.reason || 'FunASR WebSocket 连接失败，请检查地址、代理和服务是否启动'));
    });
  });
  finalPromise.catch(() => undefined);

  const hot: Record<string, number> = {};
  if (model.caps.hotwords) for (const h of opts.hotwords) hot[h.word] = h.weight;
  ws.send(
    JSON.stringify({
      mode,
      chunk_size: parseChunkSize(model.funasrChunkSize),
      chunk_interval: 10,
      wav_name: `web-${Date.now()}`,
      is_speaking: true,
      wav_format: 'pcm',
      audio_fs: 16000,
      hotwords: JSON.stringify(hot),
      itn: true,
      ...parseExtra(model),
    }),
  );

  return {
    sendPcm(pcm) {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    },
    finish() {
      finishing = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ is_speaking: false }));
      // 兜底：服务端若不返回 is_final，也不要一直挂着
      setTimeout(() => {
        settle();
        ws.close();
      }, 15000);
      return finalPromise;
    },
    close() {
      settled = true;
      ws.close();
    },
  };
}

/** 一次性推送整段 PCM（文件/整段录音）并取回最终结果。 */
export async function transcribeFunAsr(model: ModelConfig, pcm: Int16Array, opts: FunAsrOptions): Promise<AsrResult> {
  const session = await openFunAsrSession(model, opts);
  const step = 960 * 4; // 240ms / 包
  for (let i = 0; i < pcm.length; i += step) {
    session.sendPcm(pcm.subarray(i, Math.min(pcm.length, i + step)));
    if ((i / step) % 20 === 19) await new Promise((r) => setTimeout(r, 5));
  }
  return session.finish();
}
