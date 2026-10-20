import { useEffect, useMemo, useRef, useState } from 'react';
import { startLiveAsr, supportsRealtimeMic, transcribe, type LiveSession } from '../asr';
import { decodeToPcm16k } from '../audio/decode';
import { MicCapture } from '../audio/mic';
import { concatInt16, encodeWav } from '../audio/wav';
import { CapBadges, ErrorBox, LevelMeter, Metric, ModelSelect, Panel, ms, useModelById, useTimer } from '../components/common';
import { HotwordManager, useHotwords } from '../components/HotwordManager';
import type { AsrResult } from '../lib/types';

type Source = 'file' | 'mic';

export default function AsrPage() {
  const [modelId, setModelId] = useState('');
  const model = useModelById(modelId);
  const hotwords = useHotwords(model);
  const [source, setSource] = useState<Source>('file');
  const [stream, setStream] = useState(true);
  const [language, setLanguage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [audioSec, setAudioSec] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(-70);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AsrResult>();
  const [error, setError] = useState<string>();
  const recSec = useTimer(recording);

  const mic = useRef<MicCapture | null>(null);
  const live = useRef<LiveSession | null>(null);
  const pcmParts = useRef<Int16Array[]>([]);
  const abort = useRef<AbortController | null>(null);

  const realtime = !!model && supportsRealtimeMic(model) && stream;
  const canStream = !!model?.caps.streaming;

  useEffect(() => {
    if (model && !model.caps.streaming) setStream(false);
  }, [model]);

  useEffect(() => () => {
    mic.current?.stop();
    live.current?.close();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const setAudio = (blob: Blob, sec?: number) => {
    setAudioUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
    setAudioSec(sec);
  };

  const finishWith = (r: AsrResult, sec?: number) => {
    setResult({ ...r, totalMs: r.totalMs });
    setText(r.text);
    if (sec) setAudioSec(sec);
  };

  const onFile = async (f: File | null) => {
    setFile(f);
    setResult(undefined);
    setText('');
    setError(undefined);
    if (!f) return;
    setAudio(f);
    try {
      const pcm = await decodeToPcm16k(f);
      setAudioSec(pcm.length / 16000);
    } catch {
      setAudioSec(undefined);
    }
  };

  const runFile = async () => {
    if (!model || !file) return;
    setBusy(true);
    setError(undefined);
    setText('');
    setResult(undefined);
    abort.current = new AbortController();
    try {
      const r = await transcribe(model, { kind: 'file', file }, { language: language || undefined, hotwords, stream, signal: abort.current.signal, onPartial: setText });
      finishWith(r);
    } catch (e) {
      if (!abort.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startRec = async () => {
    if (!model) return;
    setError(undefined);
    setText('');
    setResult(undefined);
    pcmParts.current = [];
    try {
      if (realtime) {
        live.current = await startLiveAsr(model, { hotwords, onPartial: setText });
      }
      mic.current = new MicCapture();
      await mic.current.start((pcm) => {
        pcmParts.current.push(pcm);
        live.current?.sendPcm(pcm);
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
        setLevel(20 * Math.log10(peak / 32768 + 1e-6));
      });
      setRecording(true);
    } catch (e) {
      mic.current?.stop();
      live.current?.close();
      live.current = null;
      setError((e as Error).message || '无法开始录音');
    }
  };

  const stopRec = async () => {
    mic.current?.stop();
    mic.current = null;
    setRecording(false);
    setLevel(-70);
    const pcm = concatInt16(pcmParts.current);
    const sec = pcm.length / 16000;
    if (pcm.length) setAudio(encodeWav(pcm, 16000), sec);
    if (!model || !pcm.length) return;
    setBusy(true);
    abort.current = new AbortController();
    try {
      if (live.current) {
        const session = live.current;
        live.current = null;
        finishWith(await session.finish(), sec);
      } else {
        const r = await transcribe(model, { kind: 'pcm', pcm }, { language: language || undefined, hotwords, stream, signal: abort.current.signal, onPartial: setText });
        finishWith(r, sec);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rtf = useMemo(() => (result && audioSec ? result.totalMs / 1000 / audioSec : undefined), [result, audioSec]);

  return (
    <div className="grid">
      <div className="col">
        <Panel title="模型与参数">
          <ModelSelect kind="asr" label="ASR 模型" value={modelId} onChange={setModelId} />
          <CapBadges model={model} />
          <label className="check">
            <input type="checkbox" checked={stream && canStream} disabled={!canStream} onChange={(e) => setStream(e.target.checked)} />
            流式输出{!canStream && '（该模型未声明支持）'}
          </label>
          {model?.protocol === 'openai-transcriptions' && (
            <label className="field">
              <span>语言（可留空自动识别）</span>
              <input placeholder="如 zh / en" value={language} onChange={(e) => setLanguage(e.target.value)} />
            </label>
          )}
          {model && (
            <small className="muted">
              {model.caps.vad ? '服务端已部署 VAD，长音频由服务端自动切分。' : '服务端未声明 VAD：长音频建议先在本地切分，或在部署时加入 VAD。'}
              {model.caps.speaker && ' 已声明声纹/说话人分离：结果中若带 spk 字段会一并展示。'}
            </small>
          )}
        </Panel>
        <HotwordManager model={model} />
      </div>

      <div className="col wide">
        <Panel title="音频输入">
          <div className="tabs small">
            <button className={source === 'file' ? 'active' : ''} onClick={() => setSource('file')}>
              上传文件
            </button>
            <button className={source === 'mic' ? 'active' : ''} onClick={() => setSource('mic')}>
              麦克风
            </button>
          </div>
          {source === 'file' ? (
            <div className="stack">
              <input type="file" accept="audio/*,video/*" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              <div className="row">
                <button className="primary" disabled={!model || !file || busy} onClick={runFile}>
                  {busy ? '识别中…' : '开始识别'}
                </button>
                {busy && (
                  <button onClick={() => abort.current?.abort()}>取消</button>
                )}
              </div>
            </div>
          ) : (
            <div className="stack">
              <div className="row">
                {!recording ? (
                  <button className="primary" disabled={!model || busy} onClick={startRec}>
                    ● 开始录制
                  </button>
                ) : (
                  <button className="danger" onClick={stopRec}>
                    ■ 停止{realtime ? '' : '并识别'}
                  </button>
                )}
                {recording && <span className="rec-dot">录音中 {recSec.toFixed(1)}s</span>}
              </div>
              <LevelMeter db={level} active={recording} />
              <small className="muted">
                {realtime
                  ? '实时模式：边说边识别（WebSocket 推流）。'
                  : '录制模式：点击停止后整段发送识别' + (stream && canStream ? '，结果将流式返回。' : '。')}
              </small>
            </div>
          )}
          {audioUrl && <audio controls src={audioUrl} className="audio" />}
        </Panel>

        <Panel
          title="识别结果"
          extra={text && <button onClick={() => navigator.clipboard?.writeText(text)}>复制</button>}
        >
          <ErrorBox error={error} />
          <div className="result-text" data-testid="asr-text">
            {text || <span className="muted">结果会显示在这里</span>}
            {busy && <span className="cursor">▍</span>}
          </div>
          {result && (
            <div className="metrics">
              <Metric label="首字延迟" value={ms(result.firstTokenMs)} hint="从发出请求到收到第一个识别字" />
              <Metric label="总耗时" value={ms(result.totalMs)} />
              <Metric label="音频时长" value={audioSec ? `${audioSec.toFixed(1)} s` : undefined} />
              <Metric label="RTF" value={rtf?.toFixed(3)} hint="总耗时 / 音频时长，越小越快" />
            </div>
          )}
          {result?.segments && result.segments.length > 0 && (
            <table className="segments">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>说话人</th>
                  <th>文本</th>
                </tr>
              </thead>
              <tbody>
                {result.segments.map((s, i) => (
                  <tr key={i}>
                    <td>{s.start !== undefined ? `${s.start.toFixed(1)}–${(s.end ?? 0).toFixed(1)}s` : '—'}</td>
                    <td>{s.spk !== undefined ? `SPK${s.spk}` : '—'}</td>
                    <td>{s.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
