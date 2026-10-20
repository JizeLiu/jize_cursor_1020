import { useEffect, useRef, useState } from 'react';
import { PcmStreamPlayer } from '../audio/player';
import { ErrorBox, Metric, ModelSelect, Panel, ms, useModelById } from '../components/common';
import { synthesize, type TtsMetrics } from '../tts/speech';

interface HistoryItem {
  id: number;
  text: string;
  url: string;
  metrics: TtsMetrics;
  at: string;
}

const SAMPLE = '你好，欢迎体验语音合成平台。这是一段用于测试流式首包延迟的示例文本。';

export default function TtsPage() {
  const [modelId, setModelId] = useState('');
  const model = useModelById(modelId);
  const [text, setText] = useState(SAMPLE);
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [stream, setStream] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [metrics, setMetrics] = useState<TtsMetrics>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [current, setCurrent] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const player = useRef<PcmStreamPlayer | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    setVoice(model?.defaultVoice ?? '');
  }, [model?.id, model?.defaultVoice]);

  useEffect(
    () => () => {
      player.current?.dispose();
    },
    [],
  );

  const run = async () => {
    if (!model || !text.trim()) return;
    player.current?.dispose();
    setBusy(true);
    setError(undefined);
    setMetrics(undefined);
    setCurrent(undefined);
    abort.current = new AbortController();
    try {
      const p = stream ? new PcmStreamPlayer(model.ttsSampleRate || 24000) : undefined;
      player.current = p ?? null;
      const out = await synthesize(model, {
        text,
        voice: voice || undefined,
        speed,
        stream,
        player: p,
        signal: abort.current.signal,
        onMetrics: setMetrics,
      });
      const url = URL.createObjectURL(out.wav);
      setCurrent(url);
      setMetrics(out.metrics);
      setHistory((h) => [
        { id: ++seq.current, text, url, metrics: out.metrics, at: new Date().toLocaleTimeString() },
        ...h,
      ]);
      if (p) await p.end();
    } catch (e) {
      if (!abort.current.signal.aborted) setError((e as Error).message);
      player.current?.stop();
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    abort.current?.abort();
    player.current?.stop();
    setBusy(false);
  };

  return (
    <div className="grid">
      <div className="col">
        <Panel title="模型与参数">
          <ModelSelect kind="tts" label="TTS 模型" value={modelId} onChange={setModelId} />
          <label className="field">
            <span>音色 / voice</span>
            <input value={voice} placeholder="留空则用模型默认" onChange={(e) => setVoice(e.target.value)} />
          </label>
          <label className="field">
            <span>语速 {speed.toFixed(1)}x</span>
            <input type="range" min={0.5} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
            流式输出（PCM 实时播放）
          </label>
          <small className="muted">
            流式：请求 response_format=pcm + stream=true，浏览器边收边播，采样率 {model?.ttsSampleRate || 24000}Hz（需与服务端一致）。
            非流式：等待完整 wav 返回后播放。
          </small>
        </Panel>
      </div>

      <div className="col wide">
        <Panel title="合成文本">
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button className="primary" disabled={!model || busy || !text.trim()} onClick={run}>
              {busy ? '合成中…' : '合成并播放'}
            </button>
            {busy && <button onClick={stop}>停止</button>}
          </div>
          <ErrorBox error={error} />
        </Panel>

        <Panel title="延迟与指标">
          <div className="metrics">
            <Metric label="响应头" value={ms(metrics?.headersMs)} hint="发出请求 → 收到 HTTP 响应头" />
            <Metric label="首包延迟 (TTFB)" value={ms(metrics?.firstChunkMs)} hint="发出请求 → 收到第一块音频数据" />
            <Metric label="首声音" value={ms(metrics?.firstPlayMs)} hint="发出请求 → 第一个采样送入播放（不含声卡输出延迟）" />
            <Metric label="总耗时" value={ms(metrics?.totalMs)} />
            <Metric label="音频时长" value={metrics?.audioSec !== undefined ? `${metrics.audioSec.toFixed(2)} s` : undefined} />
            <Metric label="RTF" value={metrics?.rtf?.toFixed(3)} hint="生成耗时 / 音频时长，<1 才能无卡顿流式播放" />
          </div>
        </Panel>

        <Panel title="回放与下载（WAV）">
          {current ? (
            <div className="stack">
              <audio controls src={current} className="audio" data-testid="tts-audio" />
              <a className="button" href={current} download={`tts-${Date.now()}.wav`}>
                下载 WAV
              </a>
            </div>
          ) : (
            <span className="muted">合成完成后可在这里整体回放、下载</span>
          )}
          {history.length > 0 && (
            <details open>
              <summary>历史记录（{history.length}）</summary>
              <ul className="history">
                {history.map((h) => (
                  <li key={h.id}>
                    <div className="history-head">
                      <span>{h.at}</span>
                      <span className="muted">TTFB {ms(h.metrics.firstChunkMs)}</span>
                      <a href={h.url} download={`tts-${h.id}.wav`}>
                        下载
                      </a>
                    </div>
                    <p>{h.text}</p>
                    <audio controls src={h.url} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      </div>
    </div>
  );
}
