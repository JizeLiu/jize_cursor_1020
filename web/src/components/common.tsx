import { useEffect, useState, type ReactNode } from 'react';
import { useModels, useStore } from '../lib/store';
import type { ModelConfig, ModelKind } from '../lib/types';

export function ModelSelect({
  kind,
  value,
  onChange,
  label,
  optional,
}: {
  kind: ModelKind;
  value: string;
  onChange: (id: string) => void;
  label: string;
  optional?: boolean;
}) {
  const models = useModels(kind);
  useEffect(() => {
    if (!optional && models.length && !models.some((m) => m.id === value)) onChange(models[0].id);
  }, [models, value, optional, onChange]);

  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {optional && <option value="">不使用（复读模式）</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {models.length === 0 && !optional && (
        <small className="warn">还没有配置{kind.toUpperCase()}模型，请先到「模型管理」添加。</small>
      )}
    </label>
  );
}

export function useModelById(id: string): ModelConfig | undefined {
  const { models } = useStore();
  return models.find((m) => m.id === id);
}

export function CapBadges({ model }: { model?: ModelConfig }) {
  if (!model) return null;
  const c = model.caps;
  const items: Array<[string, boolean]> = [
    ['流式', c.streaming],
    ['实时麦克风', c.realtimeMic],
    ['热词', c.hotwords],
    ['服务端 VAD', c.vad],
    ['标点', c.punc],
    ['声纹/说话人', c.speaker],
  ];
  return (
    <div className="badges">
      {items.map(([name, on]) => (
        <span key={name} className={`badge ${on ? 'on' : ''}`}>
          {name}
        </span>
      ))}
    </div>
  );
}

export function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="panel">
      <header>
        <h3>{title}</h3>
        {extra}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function LevelMeter({ db, active }: { db: number; active?: boolean }) {
  const pct = Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
  return (
    <div className="meter" title={`${db.toFixed(0)} dBFS`}>
      <div className={`meter-fill ${active ? 'active' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Metric({ label, value, hint }: { label: string; value?: string; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <div className="metric-value">{value ?? '—'}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

export const ms = (v?: number) => (v === undefined ? undefined : `${Math.round(v)} ms`);

export function useTimer(running: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    setSec(0);
    const id = setInterval(() => setSec((Date.now() - t0) / 1000), 200);
    return () => clearInterval(id);
  }, [running]);
  return sec;
}

export function ErrorBox({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="error">{error}</div>;
}
