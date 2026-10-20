export type ModelKind = 'asr' | 'tts' | 'llm';

export type AsrProtocol = 'openai-transcriptions' | 'funasr-ws';
export type TtsProtocol = 'openai-speech';
export type LlmProtocol = 'openai-chat';

/**
 * 服务端部署时已经具备的能力。平台不会在客户端重复实现这些能力，
 * 只会根据声明来决定展示哪些控件、如何拼装请求。
 */
export interface AsrCaps {
  /** 支持流式输出（openai: SSE；funasr: online/2pass 模式） */
  streaming: boolean;
  /** 支持实时麦克风推流（funasr-ws） */
  realtimeMic: boolean;
  /** 支持热词 */
  hotwords: boolean;
  /** 部署时已带 VAD（如 FunASR 的 fsmn-vad），服务端自行切分 */
  vad: boolean;
  /** 部署时已带标点恢复（如 ct-punc） */
  punc: boolean;
  /** 部署时已带说话人分离/声纹（如 CAM++），结果里会带 spk 字段 */
  speaker: boolean;
}

/** openai 协议下热词如何传给服务端 */
export type HotwordMode = 'prompt' | 'field' | 'none';

export interface ModelConfig {
  id: string;
  kind: ModelKind;
  name: string;
  protocol: AsrProtocol | TtsProtocol | LlmProtocol;
  /** http(s)://host:port 或 ws(s)://host:port，openai 协议可带或不带 /v1 */
  baseUrl: string;
  apiKey?: string;
  /** 请求体中的 model 字段 */
  model?: string;
  caps: AsrCaps;
  hotwordMode: HotwordMode;
  /** 额外请求参数（JSON 字符串），会合并进请求体/表单 */
  extraBody?: string;
  /** TTS：返回 PCM 的采样率 */
  ttsSampleRate?: number;
  /** TTS：默认音色 */
  defaultVoice?: string;
  /** funasr-ws：实时模式 */
  funasrMode?: 'online' | 'offline' | '2pass';
  /** funasr-ws：chunk_size，默认 5,10,5 */
  funasrChunkSize?: string;
}

export interface Hotword {
  word: string;
  weight: number;
}

export interface AsrSegment {
  text: string;
  start?: number;
  end?: number;
  spk?: number;
}

export interface AsrResult {
  text: string;
  segments?: AsrSegment[];
  firstTokenMs?: number;
  totalMs: number;
}

export const DEFAULT_CAPS: AsrCaps = {
  streaming: false,
  realtimeMic: false,
  hotwords: false,
  vad: false,
  punc: false,
  speaker: false,
};
