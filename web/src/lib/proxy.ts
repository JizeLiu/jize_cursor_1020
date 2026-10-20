import type { ModelConfig } from './types';

/** 通过平台自带的 Node 代理访问用户部署的模型服务，规避 CORS 并保护密钥。 */
export function proxiedUrl(target: string): string {
  return `/api/proxy?url=${encodeURIComponent(target)}`;
}

export function proxiedWsUrl(target: string, headers?: Record<string, string>): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const h = headers && Object.keys(headers).length ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : '';
  return `${scheme}://${location.host}/api/ws-proxy?url=${encodeURIComponent(target)}${h}`;
}

/** 拼接 OpenAI 兼容接口地址：baseUrl 带不带 /v1 都可以。 */
export function openaiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (/\/v1$/.test(base)) return `${base}/${p}`;
  return `${base}/v1/${p}`;
}

export function authHeaders(model: ModelConfig): Record<string, string> {
  return model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {};
}

export function parseExtra(model: ModelConfig): Record<string, unknown> {
  if (!model.extraBody?.trim()) return {};
  try {
    const v = JSON.parse(model.extraBody);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new Error(`模型「${model.name}」的额外参数不是合法 JSON`);
  }
}

export async function proxyFetch(
  target: string,
  model: ModelConfig,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const res = await fetch(proxiedUrl(target), {
    ...init,
    headers: { ...authHeaders(model), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      // ignore
    }
    throw new Error(`请求失败 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  return res;
}
