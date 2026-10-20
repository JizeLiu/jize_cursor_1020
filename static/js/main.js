// 入口：先加载模型列表，再初始化各页面脚本，最后处理页面切换（首页 / 顶部标签 / 带 data-go 的链接）。
import { loadModels, models, $ } from './common.js';
import './models.js';
import './asr.js';
import './tts.js';
import './wake.js';
import './call.js';
import './deploy.js';

const PAGES = ['home', 'asr', 'tts', 'wake', 'call', 'models', 'deploy'];
const tabs = document.querySelectorAll('#tabs button');

function showPage(name) {
  if (!PAGES.includes(name)) name = 'home';
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => (p.hidden = p.id !== `page-${name}`));
  history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}

tabs.forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-go]');
  if (link) showPage(link.dataset.go);
});
showPage(location.hash.slice(1));

/** 首页：每个功能卡片显示所需模型是否已添加。 */
function renderHomeStatus() {
  const count = (kind) => models.filter((m) => m.kind === kind).length;
  const text = {
    asr: count('asr') ? [`已有 ${count('asr')} 个 ASR 模型`, 'ready'] : ['还没有 ASR 模型，先去添加', 'missing'],
    tts: count('tts') ? [`已有 ${count('tts')} 个 TTS 模型`, 'ready'] : ['还没有 TTS 模型，先去添加', 'missing'],
    call: count('asr') && count('tts') ? ['ASR 和 TTS 模型已就绪', 'ready'] : ['需要先添加 ASR 和 TTS 模型', 'missing'],
  };
  document.querySelectorAll('.feature-status').forEach((el) => {
    const [label, state] = text[el.dataset.kind];
    el.textContent = label;
    el.className = `feature-status ${state}`;
  });
  $('#home-model-count').textContent = `共 ${models.length} 个模型 →`;
}

document.addEventListener('models-changed', renderHomeStatus);
loadModels();
