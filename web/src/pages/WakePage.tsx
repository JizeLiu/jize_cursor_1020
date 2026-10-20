import { useEffect, useRef, useState } from 'react';
import { transcribe } from '../asr';
import { VadListener } from '../audio/listener';
import { CapBadges, ErrorBox, LevelMeter, ModelSelect, Panel, ms, useModelById } from '../components/common';
import { HotwordManager, useHotwords } from '../components/HotwordManager';
import { matchWake, textAfter } from '../lib/wake';

type Phase = 'off' | 'sleeping' | 'awake';

interface LogItem {
  id: number;
  at: string;
  text: string;
  hit: boolean;
  ms: number;
}

export default function WakePage() {
  const [modelId, setModelId] = useState('');
  const model = useModelById(modelId);
  const hotwords = useHotwords(model);
  const [wakeInput, setWakeInput] = useState('你好小智');
  const [fuzzy, setFuzzy] = useState(0.25);
  const [awakeSec, setAwakeSec] = useState(8);
  const [sensitivity, setSensitivity] = useState(12);
  const [phase, setPhase] = useState<Phase>('off');
  const [level, setLevel] = useState(-70);
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [log, setLog] = useState<LogItem[]>([]);
  const [error, setError] = useState<string>();
  const [remain, setRemain] = useState(0);

  const listener = useRef<VadListener | null>(null);
  const phaseRef = useRef<Phase>('off');
  const awakeUntil = useRef(0);
  const seq = useRef(0);
  const queue = useRef(Promise.resolve());

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  useEffect(() => () => listener.current?.stop(), []);

  useEffect(() => {
    if (phase !== 'awake') return;
    const id = setInterval(() => {
      const left = (awakeUntil.current - Date.now()) / 1000;
      setRemain(Math.max(0, left));
      if (left <= 0 && phaseRef.current === 'awake') setPhaseBoth('sleeping');
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  const words = () =>
    wakeInput
      .split(/[,，、\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSegment = (pcm: Int16Array) => {
    if (!model) return;
    // 串行处理，避免并发请求乱序
    queue.current = queue.current.then(async () => {
      const t0 = performance.now();
      try {
        const r = await transcribe(model, { kind: 'pcm', pcm }, { hotwords, stream: false });
        const text = r.text.trim();
        if (!text) return;
        const cost = performance.now() - t0;
        if (phaseRef.current === 'awake') {
          awakeUntil.current = Date.now() + awakeSec * 1000;
          setTranscript((t) => [...t, text]);
          setLog((l) => [{ id: ++seq.current, at: new Date().toLocaleTimeString(), text, hit: false, ms: cost }, ...l].slice(0, 50));
          return;
        }
        const hit = matchWake(text, words(), fuzzy);
        setLog((l) => [{ id: ++seq.current, at: new Date().toLocaleTimeString(), text, hit: !!hit, ms: cost }, ...l].slice(0, 50));
        if (hit) {
          setPhaseBoth('awake');
          awakeUntil.current = Date.now() + awakeSec * 1000;
          const rest = textAfter(text, hit.endIndex);
          setTranscript((t) => [...t, `【已唤醒：${hit.word}】`, ...(rest ? [rest] : [])]);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  const start = async () => {
    if (!model) return;
    setError(undefined);
    setTranscript([]);
    const l = new VadListener();
    try {
      await l.start(
        {
          onSegment: handleSegment,
          onLevel: (db, sp) => {
            setLevel(db);
            setSpeaking(sp);
          },
        },
        { marginDb: sensitivity },
      );
      listener.current = l;
      setPhaseBoth('sleeping');
    } catch (e) {
      l.stop();
      setError((e as Error).message || '无法打开麦克风');
    }
  };

  const stop = () => {
    listener.current?.stop();
    listener.current = null;
    setPhaseBoth('off');
    setLevel(-70);
    setSpeaking(false);
  };

  return (
    <div className="grid">
      <div className="col">
        <Panel title="模型与唤醒词">
          <ModelSelect kind="asr" label="ASR 模型" value={modelId} onChange={setModelId} />
          <CapBadges model={model} />
          <label className="field">
            <span>唤醒词（多个用逗号分隔，可把常见误识别写法也加进去）</span>
            <input value={wakeInput} disabled={phase !== 'off'} onChange={(e) => setWakeInput(e.target.value)} />
          </label>
          <label className="field">
            <span>模糊匹配容错 {Math.round(fuzzy * 100)}%</span>
            <input type="range" min={0} max={0.5} step={0.05} value={fuzzy} onChange={(e) => setFuzzy(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>唤醒后保持时长 {awakeSec}s（无语音后回到待机）</span>
            <input type="range" min={3} max={30} step={1} value={awakeSec} onChange={(e) => setAwakeSec(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>VAD 灵敏度（阈值高于底噪 {sensitivity} dB）</span>
            <input
              type="range"
              min={6}
              max={24}
              step={1}
              value={sensitivity}
              disabled={phase !== 'off'}
              onChange={(e) => setSensitivity(Number(e.target.value))}
            />
          </label>
          <small className="muted">
            原理：客户端 VAD 切出语音段 → 送 ASR → 文本命中唤醒词才进入识别状态。待机阶段的语音段也会发给 ASR 服务（仅用于判断是否命中）。
          </small>
        </Panel>
        <HotwordManager model={model} />
      </div>

      <div className="col wide">
        <Panel title="监听状态">
          <div className={`wake-status ${phase}`}>
            <div className="wake-orb" />
            <div>
              <strong>{phase === 'off' ? '未开始' : phase === 'sleeping' ? '待机监听中…' : `已唤醒 · ${remain.toFixed(0)}s 后待机`}</strong>
              <div className="muted">{phase === 'sleeping' ? `请说：${words().join(' / ')}` : phase === 'awake' ? '现在说的内容会被识别' : '点击开始后实时监听麦克风'}</div>
            </div>
          </div>
          <LevelMeter db={level} active={speaking} />
          <div className="row">
            {phase === 'off' ? (
              <button className="primary" disabled={!model} onClick={start}>
                开始监听
              </button>
            ) : (
              <button className="danger" onClick={stop}>
                停止监听
              </button>
            )}
          </div>
          <ErrorBox error={error} />
        </Panel>

        <Panel title="唤醒后的识别结果">
          <div className="result-text" data-testid="wake-transcript">
            {transcript.length ? transcript.map((t, i) => <p key={i}>{t}</p>) : <span className="muted">唤醒后的识别文本会显示在这里</span>}
          </div>
        </Panel>

        <Panel title="语音段日志">
          <ul className="log">
            {log.map((l) => (
              <li key={l.id} className={l.hit ? 'hit' : ''}>
                <span className="muted">{l.at}</span>
                <span>{l.text}</span>
                <span className="muted">{ms(l.ms)}</span>
                {l.hit && <span className="badge on">命中唤醒词</span>}
              </li>
            ))}
            {log.length === 0 && <span className="muted">暂无</span>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
