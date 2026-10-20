// 入口：先加载模型列表，再初始化各页面脚本，最后处理顶部标签页切换。
import { loadModels } from './common.js';
import './models.js';
import './asr.js';
import './tts.js';
import './wake.js';
import './call.js';

const tabs = document.querySelectorAll('#tabs button');

function showPage(name) {
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => (p.hidden = p.id !== `page-${name}`));
  history.replaceState(null, '', `#${name}`);
}

tabs.forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
showPage([...tabs].some((b) => b.dataset.page === location.hash.slice(1)) ? location.hash.slice(1) : 'asr');

loadModels();
