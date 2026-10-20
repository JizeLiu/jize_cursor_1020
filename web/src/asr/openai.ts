import { encodeWav } from '../audio/wav';
import { openaiUrl, parseExtra, proxyFetch } from '../lib/proxy';
import { readSse } from '../lib/sse';
import type { AsrResult, Hotword, ModelConfig } from '../lib/types';

export interface OpenAiAsrOptions {
  language?: string;
  hotwords: Hotword[];
  stream: boolean;
  signal?: AbortSignal;
  onPartial?: (text: string) => void;
}

function appendHotwords(form: FormData, model: ModelConfig, hotwords: Hotword[]) {
  if (!hotwords.length || !model.caps.hotwords || model.hotwordMode === 'none') return;
  if (model.hotwordMode === 'field') {
    form.append('hotwords', hotwords.map((h) => h.word).join(','));
  } else {
    form.append('prompt', `热词：${hotwords.map((h) => h.word).join('、')}`);
  }
}

/** vLLM / OpenAI 兼容的 /v1/audio/transcriptions */
export async function transcribeOpenAi(
  model: ModelConfig,
  input: { blob: Blob; filename: string },
  opts: OpenAiAsrOptions,
): Promise<AsrResult> {
  const form = new FormData();
  form.append('file', input.blob, input.filename);
  if (model.model) form.append('model', model.model);
  if (opts.language) form.append('language', opts.language);
  const wantStream = opts.stream && model.caps.streaming;
  if (wantStream) form.append('stream', 'true');
  appendHotwords(form, model, opts.hotwords);
  for (const [k, v] of Object.entries(parseExtra(model))) {
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  const t0 = performance.now();
  const res = await proxyFetch(openaiUrl(model.baseUrl, 'audio/transcriptions'), model, {
    method: 'POST',
    body: form,
    signal: opts.signal,
  });

  const type = res.headers.get('content-type') || '';
  if (wantStream && type.includes('text/event-stream')) {
    let text = '';
    let firstTokenMs: number | undefined;
    for await (const data of readSse(res)) {
      if (data === '[DONE]') break;
      let obj: any;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      // vLLM: choices[0].delta.content；OpenAI: transcript.text.delta / transcript.text.done
      const delta: string | undefined = obj?.choices?.[0]?.delta?.content ?? (obj?.type === 'transcript.text.delta' ? obj.delta : undefined);
      if (delta) {
        firstTokenMs ??= performance.now() - t0;
        text += delta;
        opts.onPartial?.(text);
      } else if (obj?.type === 'transcript.text.done' && typeof obj.text === 'string') {
        text = obj.text;
        opts.onPartial?.(text);
      }
    }
    return { text, firstTokenMs, totalMs: performance.now() - t0 };
  }

  const body = await res.json();
  const text: string = body.text ?? body.choices?.[0]?.message?.content ?? '';
  const totalMs = performance.now() - t0;
  opts.onPartial?.(text);
  return {
    text,
    totalMs,
    firstTokenMs: totalMs,
    segments: Array.isArray(body.segments)
      ? body.segments.map((s: any) => ({ text: s.text, start: s.start, end: s.end }))
      : undefined,
  };
}

export function pcmToWavFile(pcm: Int16Array): { blob: Blob; filename: string } {
  return { blob: encodeWav(pcm, 16000), filename: 'audio.wav' };
}
