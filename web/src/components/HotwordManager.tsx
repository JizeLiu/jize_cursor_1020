import { useState } from 'react';
import { setHotwords, useStore } from '../lib/store';
import type { Hotword, ModelConfig } from '../lib/types';
import { Panel } from './common';

export function useHotwords(model?: ModelConfig): Hotword[] {
  const { hotwords } = useStore();
  return model ? (hotwords[model.id] ?? []) : [];
}

export function HotwordManager({ model }: { model?: ModelConfig }) {
  const list = useHotwords(model);
  const [word, setWord] = useState('');
  const [weight, setWeight] = useState(20);

  if (!model) return null;
  const disabled = !model.caps.hotwords;

  const add = () => {
    const w = word.trim();
    if (!w) return;
    const next = [...list.filter((h) => h.word !== w), { word: w, weight }];
    setHotwords(model.id, next);
    setWord('');
  };

  const bulk = (text: string) => {
    const parsed: Hotword[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(.+?)(?:\s+(\d+))?$/);
      if (m) parsed.push({ word: m[1].trim(), weight: Number(m[2] ?? 20) });
    }
    setHotwords(model.id, parsed);
  };

  return (
    <Panel
      title={`热词管理（${list.length}）`}
      extra={disabled ? <span className="muted">该模型未声明支持热词</span> : undefined}
    >
      <div className="row">
        <input
          placeholder="输入热词，回车添加"
          value={word}
          disabled={disabled}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          type="number"
          className="narrow"
          min={1}
          max={100}
          title="权重（FunASR 常用 1~100）"
          value={weight}
          disabled={disabled}
          onChange={(e) => setWeight(Number(e.target.value))}
        />
        <button onClick={add} disabled={disabled}>
          添加
        </button>
      </div>
      <div className="chips">
        {list.map((h) => (
          <span className="chip" key={h.word}>
            {h.word}
            <em>{h.weight}</em>
            <button
              aria-label={`删除 ${h.word}`}
              onClick={() =>
                setHotwords(
                  model.id,
                  list.filter((x) => x.word !== h.word),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
        {list.length === 0 && <span className="muted">暂无热词</span>}
      </div>
      <details>
        <summary>批量编辑（每行：热词 权重）</summary>
        <textarea
          rows={5}
          disabled={disabled}
          value={list.map((h) => `${h.word} ${h.weight}`).join('\n')}
          onChange={(e) => bulk(e.target.value)}
        />
      </details>
      <small className="muted">
        {model.protocol === 'funasr-ws'
          ? '将以 JSON {词: 权重} 通过 FunASR hotwords 字段下发。'
          : model.hotwordMode === 'field'
            ? '将通过表单字段 hotwords（逗号分隔）下发。'
            : '将拼进 prompt 字段下发（模型需支持 prompt 偏置）。'}
      </small>
    </Panel>
  );
}
