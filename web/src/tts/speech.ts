import { PcmStreamPlayer } from '../audio/player';
import { encodeWav } from '../audio/wav';
import { openaiUrl, parseExtra, proxyFetch } from '../lib/proxy';
import type { ModelConfig } from '../lib/types';

export interface TtsMetrics {
  /** 点击合成 → 收到响应头 */
  headersMs?: number;
  /** 点击合成 → 收到第一块音频数据（首包延迟 TTFB） */
  firstChunkMs?: number;
  /** 点击合成 → 第一个音频采样被送入播放（含调度，不含声卡输出延迟） */
  firstPlayMs?: number;
  /** 声卡/系统估算输出延迟 */
  outputLatencyMs?: number;
  totalMs?: number;
  audioSec?: number;
  /** 实时率 = 生成耗时 / 音频时长，<1 才能无卡顿流式播放 */
  rtf?: number;
  bytes?: number;
  chunks?: number;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  /** true：PCM 流式；false：等待整段 wav 返回 */
  stream: boolean;
  signal?: AbortSignal;
  /** 可复用外部播放器（通话场景多句拼接）；不传则内部创建 */
  player?: PcmStreamPlayer;
  /** 通话等场景不需要自己拼 wav 时可以关掉播放，仅用于非流式 */
  onMetrics?: (m: TtsMetrics) => void;
}

export interface TtsOutput {
  wav: Blob;
  sampleRate: number;
  metrics: TtsMetrics;
}

export async function synthesize(model: ModelConfig, req: TtsRequest): Promise<TtsOutput> {
  const sampleRate = model.ttsSampleRate || 24000;
  const t0 = performance.now();
  const metrics: TtsMetrics = {};
  const emit = () => req.onMetrics?.({ ...metrics });

  const body: Record<string, unknown> = {
    ...(model.model ? { model: model.model } : {}),
    input: req.text,
    voice: req.voice || model.defaultVoice || undefined,
    speed: req.speed && req.speed !== 1 ? req.speed : undefined,
    response_format: req.stream ? 'pcm' : 'wav',
    stream: req.stream || undefined,
    ...parseExtra(model),
  };

  const res = await proxyFetch(openaiUrl(model.baseUrl, 'audio/speech'), model, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  metrics.headersMs = performance.now() - t0;
  emit();

  if (!req.stream) {
    const buf = await res.arrayBuffer();
    metrics.firstChunkMs = performance.now() - t0;
    metrics.totalMs = metrics.firstChunkMs;
    metrics.bytes = buf.byteLength;
    const wav = new Blob([buf], { type: 'audio/wav' });
    emit();
    return { wav, sampleRate, metrics };
  }

  const player = req.player ?? new PcmStreamPlayer(sampleRate);
  const ownPlayer = !req.player;
  const startPcmLen = player.getPcm().length;
  let chunks = 0;
  let bytes = 0;
  const prevOnFirst = player.onFirstPlay;
  player.onFirstPlay = (at) => {
    metrics.firstPlayMs = at - t0;
    metrics.outputLatencyMs = player.outputLatencyMs;
    prevOnFirst?.(at);
    emit();
  };

  const reader = res.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (metrics.firstChunkMs === undefined) {
        metrics.firstChunkMs = performance.now() - t0;
        emit();
      }
      chunks++;
      bytes += value.length;
      player.push(value);
    }
  } catch (e) {
    if (ownPlayer) player.stop();
    throw e;
  } finally {
    reader.releaseLock();
    player.onFirstPlay = prevOnFirst;
  }

  metrics.totalMs = performance.now() - t0;
  metrics.bytes = bytes;
  metrics.chunks = chunks;
  const pcm = player.getPcm().slice(startPcmLen);
  metrics.audioSec = pcm.length / sampleRate;
  metrics.rtf = metrics.audioSec ? metrics.totalMs / 1000 / metrics.audioSec : undefined;
  emit();

  if (ownPlayer) await player.end();
  return { wav: encodeWav(pcm, sampleRate), sampleRate, metrics };
}
