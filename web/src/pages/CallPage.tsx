import { useEffect, useRef, useState } from 'react';
import { transcribe } from '../asr';
import { VadListener } from '../audio/listener';
import { PcmStreamPlayer } from '../audio/player';
import { ErrorBox, LevelMeter, Metric, ModelSelect, Panel, ms, useModelById, useTimer } from '../components/common';
import { HotwordManager, useHotwords } from '../components/HotwordManager';
import { streamChat, type ChatMessage } from '../llm/chat';
import { synthesize } from '../tts/speech';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Line {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  note?: string;
}

interface TurnMetrics {
  asrMs?: number;
  llmFirstMs?: number;
  ttsFirstMs?: number;
  e2eMs?: number;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未接通',
  listening: '聆听中…',
  thinking: '思考中…',
  speaking: '正在说话…',
};

const SYSTEM_PROMPT = '你是一个语音通话助手。回答要简短、口语化，一次不超过三句话，不要使用 markdown、列表或表情符号。';

/** 从缓冲里切出可以立刻送去合成的完整句子。 */
function drainSentences(buf: string, first: boolean): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (;;) {
    let idx = rest.search(/[。！？!?；;\n]/);
    if (idx < 0 && first && sentences.length === 0 && rest.length >= 14) {
      // 首句尽快出声：够长时在逗号处提前切分
      const m = [...rest.matchAll(/[，,、]/g)].map((x) => x.index!).filter((i) => i >= 5);
      if (m.length) idx = m[m.length - 1];
    }
    if (idx < 0) break;
    const s = rest.slice(0, idx + 1).trim();
    if (s) sentences.push(s);
    rest = rest.slice(idx + 1);
  }
  return { sentences, rest };
}

export default function CallPage() {
  const [asrId, setAsrId] = useState('');
  const [ttsId, setTtsId] = useState('');
  const [llmId, setLlmId] = useState('');
  const asr = useModelById(asrId);
  const tts = useModelById(ttsId);
  const llm = useModelById(llmId);
  const hotwords = useHotwords(asr);
  const [systemPrompt, setSystemPrompt] = useState(SYSTEM_PROMPT);
  const [bargeIn, setBargeIn] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(-70);
  const [metrics, setMetrics] = useState<TurnMetrics>({});
  const [error, setError] = useState<string>();
  const callSec = useTimer(phase !== 'idle');

  const listener = useRef<VadListener | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const turnAbort = useRef<AbortController | null>(null);
  const player = useRef<PcmStreamPlayer | null>(null);
  const history = useRef<ChatMessage[]>([]);
  const seq = useRef(0);
  const bargeRef = useRef(bargeIn);
  const modelsRef = useRef({ asr, tts, llm, hotwords, systemPrompt });
  const logEnd = useRef<HTMLDivElement>(null);

  bargeRef.current = bargeIn;
  modelsRef.current = { asr, tts, llm, hotwords, systemPrompt };

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  useEffect(
    () => () => {
      listener.current?.stop();
      turnAbort.current?.abort();
      player.current?.dispose();
    },
    [],
  );

  const patchLine = (id: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const interrupt = (reason: string) => {
    turnAbort.current?.abort();
    player.current?.stop();
    setLines((ls) => {
      const last = ls[ls.length - 1];
      return last?.role === 'assistant' ? ls.map((l) => (l === last ? { ...l, note: reason } : l)) : ls;
    });
    setPhaseBoth('listening');
  };

  const runTurn = async (pcm: Int16Array, speechEndAt: number) => {
    const { asr, tts, llm, hotwords, systemPrompt } = modelsRef.current;
    if (!asr || !tts) return;
    turnAbort.current?.abort();
    const ac = new AbortController();
    turnAbort.current = ac;
    const m: TurnMetrics = {};
    setMetrics({});
    setPhaseBoth('thinking');

    try {
      const t0 = performance.now();
      const r = await transcribe(asr, { kind: 'pcm', pcm }, { hotwords, stream: false, signal: ac.signal });
      m.asrMs = performance.now() - t0;
      setMetrics({ ...m });
      const userText = r.text.trim();
      if (!userText) {
        if (!ac.signal.aborted) setPhaseBoth('listening');
        return;
      }
      setLines((ls) => [...ls, { id: ++seq.current, role: 'user', text: userText }]);
      const replyId = ++seq.current;
      setLines((ls) => [...ls, { id: replyId, role: 'assistant', text: '' }]);

      const sampleRate = tts.ttsSampleRate || 24000;
      const p = new PcmStreamPlayer(sampleRate);
      player.current = p;
      p.onFirstPlay = (at) => {
        if (ac.signal.aborted) return;
        m.e2eMs = at - speechEndAt;
        setMetrics({ ...m });
        setPhaseBoth('speaking');
      };

      let ttsChain: Promise<unknown> = Promise.resolve();
      let firstTts = true;
      const speak = (sentence: string) => {
        const isFirst = firstTts;
        firstTts = false;
        ttsChain = ttsChain.then(async () => {
          if (ac.signal.aborted) return;
          await synthesize(tts, {
            text: sentence,
            stream: true,
            player: p,
            signal: ac.signal,
            onMetrics: (tm) => {
              if (isFirst && tm.firstChunkMs !== undefined && m.ttsFirstMs === undefined) {
                m.ttsFirstMs = tm.firstChunkMs;
                setMetrics({ ...m });
              }
            },
          });
        });
      };

      let reply = '';
      if (llm) {
        const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history.current, { role: 'user', content: userText }];
        const tl = performance.now();
        let buf = '';
        let acc = '';
        let sentFirst = false;
        reply = await streamChat(llm, messages, {
          signal: ac.signal,
          onDelta: (d) => {
            if (m.llmFirstMs === undefined) {
              m.llmFirstMs = performance.now() - tl;
              setMetrics({ ...m });
            }
            buf += d;
            const { sentences, rest } = drainSentences(buf, !sentFirst);
            buf = rest;
            sentences.forEach((s) => {
              sentFirst = true;
              speak(s);
            });
            acc += d;
            patchLine(replyId, { text: acc });
          },
        });
        patchLine(replyId, { text: reply });
        if (buf.trim()) speak(buf.trim());
      } else {
        reply = userText;
        patchLine(replyId, { text: reply, note: '复读模式（未配置 LLM）' });
        speak(reply);
      }

      await ttsChain;
      if (ac.signal.aborted) return;
      history.current.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
      await p.end();
      if (!ac.signal.aborted) setPhaseBoth('listening');
    } catch (e) {
      if (!ac.signal.aborted) {
        setError((e as Error).message);
        player.current?.stop();
        setPhaseBoth('listening');
      }
    }
  };

  const dial = async () => {
    if (!asr || !tts) return;
    setError(undefined);
    setLines([]);
    setMetrics({});
    history.current = [];
    const l = new VadListener();
    try {
      await l.start({
        onSpeechStart: () => {
          if (bargeRef.current && (phaseRef.current === 'speaking' || phaseRef.current === 'thinking')) interrupt('（已被打断）');
        },
        onSegment: (pcm) => void runTurn(pcm, performance.now()),
        onLevel: (db) => setLevel(db),
      });
      listener.current = l;
      setPhaseBoth('listening');
    } catch (e) {
      l.stop();
      setError((e as Error).message || '无法打开麦克风');
    }
  };

  const hangup = () => {
    listener.current?.stop();
    listener.current = null;
    turnAbort.current?.abort();
    player.current?.dispose();
    player.current = null;
    setPhaseBoth('idle');
    setLevel(-70);
  };

  const mm = Math.floor(callSec / 60);
  const ss = Math.floor(callSec % 60);

  return (
    <div className="grid">
      <div className="col">
        <Panel title="通话配置">
          <ModelSelect kind="asr" label="ASR 模型（听）" value={asrId} onChange={setAsrId} />
          <ModelSelect kind="tts" label="TTS 模型（说）" value={ttsId} onChange={setTtsId} />
          <ModelSelect kind="llm" label="对话大模型（想，可选）" value={llmId} onChange={setLlmId} optional />
          <label className="field">
            <span>系统提示词</span>
            <textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={bargeIn} onChange={(e) => setBargeIn(e.target.checked)} />
            允许打断（说话时中断 AI 播报）
          </label>
          <small className="muted">
            链路：麦克风 → 客户端 VAD → ASR → LLM（流式）→ 按句切分 → TTS（PCM 流式）→ 实时播放。
            建议使用耳机，避免扬声器声音被麦克风拾取造成自我打断。
          </small>
        </Panel>
        <HotwordManager model={asr} />
      </div>

      <div className="col wide">
        <Panel title="通话">
          <div className={`call-card ${phase}`}>
            <div className="avatar">
              <div className="ring" />
              <span>AI</span>
            </div>
            <div className="call-info">
              <strong>{PHASE_TEXT[phase]}</strong>
              <span className="muted">{phase === 'idle' ? '点击拨打开始通话' : `通话时长 ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`}</span>
            </div>
            {phase === 'idle' ? (
              <button className="primary round" disabled={!asr || !tts} onClick={dial}>
                拨打
              </button>
            ) : (
              <button className="danger round" onClick={hangup}>
                挂断
              </button>
            )}
          </div>
          <LevelMeter db={level} active={phase === 'listening'} />
          <ErrorBox error={error} />
        </Panel>

        <Panel title="单轮延迟">
          <div className="metrics">
            <Metric label="ASR 识别" value={ms(metrics.asrMs)} />
            <Metric label="LLM 首字" value={ms(metrics.llmFirstMs)} />
            <Metric label="TTS 首包" value={ms(metrics.ttsFirstMs)} />
            <Metric label="端到端" value={ms(metrics.e2eMs)} hint="用户语音段结束 → 听到 AI 第一个声音（含 VAD 静音等待）" />
          </div>
        </Panel>

        <Panel title="对话记录">
          <div className="chat" data-testid="call-chat">
            {lines.map((l) => (
              <div key={l.id} className={`bubble ${l.role}`}>
                {l.text || '…'}
                {l.note && <em>{l.note}</em>}
              </div>
            ))}
            {lines.length === 0 && <span className="muted">通话内容会显示在这里</span>}
            <div ref={logEnd} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
