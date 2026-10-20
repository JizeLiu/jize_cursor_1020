import { useSyncExternalStore } from 'react';
import { DEFAULT_CAPS, type Hotword, type ModelConfig, type ModelKind } from './types';

interface State {
  models: ModelConfig[];
  hotwords: Record<string, Hotword[]>;
}

const KEY = 'voice-playground/v1';

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { models: parsed.models ?? [], hotwords: parsed.hotwords ?? {} };
    }
  } catch {
    // ignore corrupted storage
  }
  return { models: [], hotwords: {} };
}

let state: State = load();
const listeners = new Set<() => void>();

function commit(next: State) {
  state = next;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((l) => l());
}

export function useStore(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function useModels(kind?: ModelKind): ModelConfig[] {
  const { models } = useStore();
  return kind ? models.filter((m) => m.kind === kind) : models;
}

export function newId(): string {
  return `m_${Math.random().toString(36).slice(2, 9)}`;
}

export function upsertModel(model: ModelConfig) {
  const exists = state.models.some((m) => m.id === model.id);
  commit({
    ...state,
    models: exists ? state.models.map((m) => (m.id === model.id ? model : m)) : [...state.models, model],
  });
}

export function removeModel(id: string) {
  const { [id]: _drop, ...rest } = state.hotwords;
  commit({ models: state.models.filter((m) => m.id !== id), hotwords: rest });
}

export function replaceModels(models: ModelConfig[]) {
  commit({
    ...state,
    models: models.map((m) => ({ ...m, caps: { ...DEFAULT_CAPS, ...m.caps }, id: m.id || newId() })),
  });
}

export function setHotwords(modelId: string, list: Hotword[]) {
  commit({ ...state, hotwords: { ...state.hotwords, [modelId]: list } });
}

export function getModel(id: string | undefined): ModelConfig | undefined {
  return state.models.find((m) => m.id === id);
}
