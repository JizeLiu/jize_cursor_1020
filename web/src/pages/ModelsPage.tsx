import { useState } from 'react';
import { ErrorBox, Panel } from '../components/common';
import { authHeaders, openaiUrl, proxiedWsUrl, proxyFetch } from '../lib/proxy';
import { newId, removeModel, replaceModels, upsertModel, useStore } from '../lib/store';
import { DEFAULT_CAPS, type AsrCaps, type ModelConfig, type ModelKind } from '../lib/types';

const PRESETS: Array<{ label: string; make: () => ModelConfig }> = [
  {
    label: '+ vLLM ASR（OpenAI 兼容）',
    make: () => ({
      id: newId(),
      kind: 'asr',
      name: 'vLLM ASR',
      protocol: 'openai-transcriptions',
      baseUrl: 'http://127.0.0.1:8000',
      model: '',
      caps: { ...DEFAULT_CAPS, streaming: true, hotwords: true },
      hotwordMode: 'prompt',
    }),
  },
  {
    label: '+ FunASR WebSocket',
    make: () => ({
      id: newId(),
      kind: 'asr',
      name: 'FunASR',
      protocol: 'funasr-ws',
      baseUrl: 'ws://127.0.0.1:10095',
      caps: { streaming: true, realtimeMic: true, hotwords: true, vad: true, punc: true, speaker: false },
      hotwordMode: 'none',
      funasrMode: '2pass',
      funasrChunkSize: '5,10,5',
    }),
  },
  {
    label: '+ vLLM-Omni TTS',
    make: () => ({
      id: newId(),
      kind: 'tts',
      name: 'vLLM-Omni TTS',
      protocol: 'openai-speech',
      baseUrl: 'http://127.0.0.1:8091',
      model: '',
      caps: DEFAULT_CAPS,
      hotwordMode: 'none',
      ttsSampleRate: 24000,
      defaultVoice: '',
    }),
  },
  {
    label: '+ vLLM 对话模型',
    make: () => ({
      id: newId(),
      kind: 'llm',
      name: 'vLLM Chat',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:8001',
      model: '',
      caps: DEFAULT_CAPS,
      hotwordMode: 'none',
    }),
  },
];

const PROTOCOLS: Record<ModelKind, Array<[ModelConfig['protocol'], string]>> = {
  asr: [
    ['openai-transcriptions', 'OpenAI 兼容 /v1/audio/transcriptions（vLLM）'],
    ['funasr-ws', 'FunASR WebSocket 实时服务'],
  ],
  tts: [['openai-speech', 'OpenAI 兼容 /v1/audio/speech（vLLM-Omni）']],
  llm: [['openai-chat', 'OpenAI 兼容 /v1/chat/completions（vLLM）']],
};

const CAP_LABELS: Array<[keyof AsrCaps, string]> = [
  ['streaming', '支持流式输出'],
  ['realtimeMic', '支持实时麦克风推流'],
  ['hotwords', '支持热词'],
  ['vad', '部署时已带 VAD'],
  ['punc', '部署时已带标点'],
  ['speaker', '部署时已带声纹/说话人'],
];

const KIND_NAME: Record<ModelKind, string> = { asr: 'ASR', tts: 'TTS', llm: 'LLM' };

async function testModel(m: ModelConfig): Promise<string> {
  const t0 = performance.now();
  if (m.protocol === 'funasr-ws') {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(proxiedWsUrl(m.baseUrl, authHeaders(m)));
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('连接超时'));
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(e.reason || 'WebSocket 连接失败'));
      };
    });
  } else {
    await proxyFetch(openaiUrl(m.baseUrl, 'models'), m, { method: 'GET' });
  }
  return `连接成功（${Math.round(performance.now() - t0)} ms）`;
}

function ModelForm({ initial, onClose }: { initial: ModelConfig; onClose: () => void }) {
  const [m, setM] = useState<ModelConfig>(initial);
  const [test, setTest] = useState<{ ok: boolean; msg: string }>();
  const [testing, setTesting] = useState(false);
  const set = <K extends keyof ModelConfig>(k: K, v: ModelConfig[K]) => setM((o) => ({ ...o, [k]: v }));

  const runTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      setTest({ ok: true, msg: await testModel(m) });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    upsertModel(m);
    onClose();
  };

  return (
    <Panel title={`编辑 ${KIND_NAME[m.kind]} 模型`}>
      <div className="form-grid">
        <label className="field">
          <span>名称</span>
          <input value={m.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>协议</span>
          <select value={m.protocol} onChange={(e) => set('protocol', e.target.value as ModelConfig['protocol'])}>
            {PROTOCOLS[m.kind].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>服务地址</span>
          <input
            value={m.baseUrl}
            placeholder={m.protocol === 'funasr-ws' ? 'ws://host:10095' : 'http://host:8000（可带 /v1）'}
            onChange={(e) => set('baseUrl', e.target.value)}
          />
        </label>
        <label className="field">
          <span>API Key（可选）</span>
          <input type="password" value={m.apiKey ?? ''} onChange={(e) => set('apiKey', e.target.value)} />
        </label>
        {m.protocol !== 'funasr-ws' && (
          <label className="field">
            <span>model 名称（vLLM 启动时的 --served-model-name）</span>
            <input value={m.model ?? ''} onChange={(e) => set('model', e.target.value)} />
          </label>
        )}
        {m.kind === 'tts' && (
          <>
            <label className="field">
              <span>PCM 采样率（Hz，需与服务端输出一致）</span>
              <input type="number" value={m.ttsSampleRate ?? 24000} onChange={(e) => set('ttsSampleRate', Number(e.target.value))} />
            </label>
            <label className="field">
              <span>默认音色</span>
              <input value={m.defaultVoice ?? ''} onChange={(e) => set('defaultVoice', e.target.value)} />
            </label>
          </>
        )}
        {m.protocol === 'funasr-ws' && (
          <>
            <label className="field">
              <span>实时模式</span>
              <select value={m.funasrMode ?? '2pass'} onChange={(e) => set('funasrMode', e.target.value as ModelConfig['funasrMode'])}>
                <option value="2pass">2pass（实时 + 句尾纠正，推荐）</option>
                <option value="online">online（仅实时）</option>
                <option value="offline">offline（整句）</option>
              </select>
            </label>
            <label className="field">
              <span>chunk_size</span>
              <input value={m.funasrChunkSize ?? '5,10,5'} onChange={(e) => set('funasrChunkSize', e.target.value)} />
            </label>
          </>
        )}
        {m.kind === 'asr' && m.protocol === 'openai-transcriptions' && (
          <label className="field">
            <span>热词传递方式</span>
            <select value={m.hotwordMode} onChange={(e) => set('hotwordMode', e.target.value as ModelConfig['hotwordMode'])}>
              <option value="prompt">拼进 prompt 字段</option>
              <option value="field">独立 hotwords 表单字段</option>
              <option value="none">不传</option>
            </select>
          </label>
        )}
      </div>

      {m.kind === 'asr' && (
        <div className="caps">
          <span className="muted">声明该 ASR 服务部署时具备的能力（平台据此展示控件，并不会重复实现）：</span>
          <div className="caps-grid">
            {CAP_LABELS.map(([k, label]) => (
              <label className="check" key={k}>
                <input type="checkbox" checked={m.caps[k]} onChange={(e) => set('caps', { ...m.caps, [k]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="field">
        <span>额外请求参数（JSON，合并进请求体/表单/FunASR 首包）</span>
        <textarea rows={3} value={m.extraBody ?? ''} placeholder='{"temperature": 0}' onChange={(e) => set('extraBody', e.target.value)} />
      </label>

      <div className="row">
        <button className="primary" onClick={save} disabled={!m.name.trim() || !m.baseUrl.trim()}>
          保存
        </button>
        <button onClick={runTest} disabled={testing || !m.baseUrl.trim()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button onClick={onClose}>取消</button>
        {test && <span className={test.ok ? 'ok' : 'bad'}>{test.msg}</span>}
      </div>
    </Panel>
  );
}

export default function ModelsPage() {
  const { models } = useStore();
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [error, setError] = useState<string>();

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(models, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voice-playground-models.json';
    a.click();
  };

  const importJson = async (file: File | null) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('文件内容应为模型数组');
      replaceModels(data);
      setError(undefined);
    } catch (e) {
      setError(`导入失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="stack-page">
      <Panel
        title="已配置的模型"
        extra={
          <div className="row">
            <button onClick={exportJson} disabled={!models.length}>
              导出
            </button>
            <label className="button">
              导入
              <input type="file" accept="application/json" hidden onChange={(e) => importJson(e.target.files?.[0] ?? null)} />
            </label>
          </div>
        }
      >
        <p className="muted">
          所有模型都由你自行部署并提供接口。推荐：ASR 用 FunASR（WebSocket 实时服务）或 vLLM；TTS / 对话用 vLLM / vLLM-Omni 的 OpenAI 兼容接口。
          配置保存在浏览器本地。
        </p>
        <div className="row wrap">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setEditing(p.make())}>
              {p.label}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        <table className="models">
          <thead>
            <tr>
              <th>类型</th>
              <th>名称</th>
              <th>协议</th>
              <th>地址</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className={`badge kind-${m.kind}`}>{KIND_NAME[m.kind]}</span>
                </td>
                <td>{m.name}</td>
                <td>{m.protocol}</td>
                <td className="mono">{m.baseUrl}</td>
                <td className="row">
                  <button onClick={() => setEditing(m)}>编辑</button>
                  <button onClick={() => confirm(`删除「${m.name}」？`) && removeModel(m.id)}>删除</button>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  还没有模型，点击上方预设开始添加。本地联调可用 <code>npm run mock</code> 启动模拟服务（http://127.0.0.1:9000 / ws://127.0.0.1:9000）。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      {editing && <ModelForm key={editing.id} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
