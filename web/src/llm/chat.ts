import { openaiUrl, parseExtra, proxyFetch } from '../lib/proxy';
import { readSse } from '../lib/sse';
import type { ModelConfig } from '../lib/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容 /v1/chat/completions 流式调用（vLLM 即可）。 */
export async function streamChat(
  model: ModelConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; onDelta: (delta: string) => void },
): Promise<string> {
  const res = await proxyFetch(openaiUrl(model.baseUrl, 'chat/completions'), model, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.model, messages, stream: true, ...parseExtra(model) }),
    signal: opts.signal,
  });
  let full = '';
  for await (const data of readSse(res)) {
    if (data === '[DONE]') break;
    try {
      const delta: string | undefined = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        opts.onDelta(delta);
      }
    } catch {
      // 忽略非 JSON 心跳
    }
  }
  return full;
}
