import { useState } from 'react';
import AsrPage from './pages/AsrPage';
import CallPage from './pages/CallPage';
import ModelsPage from './pages/ModelsPage';
import TtsPage from './pages/TtsPage';
import WakePage from './pages/WakePage';

const TABS = [
  { id: 'asr', label: '语音识别 ASR', el: <AsrPage /> },
  { id: 'tts', label: '语音合成 TTS', el: <TtsPage /> },
  { id: 'wake', label: '语音唤醒', el: <WakePage /> },
  { id: 'call', label: '语音通话', el: <CallPage /> },
  { id: 'models', label: '模型管理', el: <ModelsPage /> },
] as const;

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>(() => {
    const h = location.hash.slice(1);
    return TABS.some((t) => t.id === h) ? (h as 'asr') : 'asr';
  });

  const go = (id: typeof tab) => {
    setTab(id);
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◉</span>
          语音模型体验平台
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {TABS.map((t) => (
          <div key={t.id} hidden={tab !== t.id} className="page">
            {t.el}
          </div>
        ))}
      </main>
    </div>
  );
}
