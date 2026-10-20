import { decodeToPcm16k } from '../audio/decode';
import type { AsrResult, Hotword, ModelConfig } from '../lib/types';
import { openFunAsrSession, transcribeFunAsr, type LiveSession } from './funasr';
import { pcmToWavFile, transcribeOpenAi } from './openai';

export type { LiveSession } from './funasr';

export interface TranscribeOptions {
  language?: string;
  hotwords: Hotword[];
  stream: boolean;
  signal?: AbortSignal;
  onPartial?: (text: string) => void;
}

export type AsrInput = { kind: 'file'; file: File } | { kind: 'pcm'; pcm: Int16Array };

export function audioDurationSec(pcm: Int16Array): number {
  return pcm.length / 16000;
}

/** 统一入口：给定模型和音频，返回识别结果。 */
export async function transcribe(model: ModelConfig, input: AsrInput, opts: TranscribeOptions): Promise<AsrResult> {
  if (model.protocol === 'funasr-ws') {
    const pcm = input.kind === 'pcm' ? input.pcm : await decodeToPcm16k(input.file);
    // 文件/整段录音默认走 offline，需要流式展示时用 2pass 即可
    const mode = opts.stream && model.caps.streaming ? (model.funasrMode ?? '2pass') : 'offline';
    return transcribeFunAsr(model, pcm, { hotwords: opts.hotwords, mode, onPartial: opts.onPartial, signal: opts.signal });
  }
  const file = input.kind === 'file' ? { blob: input.file, filename: input.file.name } : pcmToWavFile(input.pcm);
  return transcribeOpenAi(model, file, opts);
}

/** 麦克风实时推流（仅 funasr-ws）。 */
export function startLiveAsr(
  model: ModelConfig,
  opts: { hotwords: Hotword[]; onPartial?: (text: string) => void; signal?: AbortSignal },
): Promise<LiveSession> {
  if (model.protocol !== 'funasr-ws') throw new Error('该模型协议不支持实时麦克风推流');
  return openFunAsrSession(model, { ...opts, mode: model.funasrMode ?? '2pass' });
}

export function supportsRealtimeMic(model: ModelConfig): boolean {
  return model.protocol === 'funasr-ws' && model.caps.realtimeMic;
}
