// 所有页面共用的小工具：请求后端、模型下拉框、热词组件、显示错误和指标。

export const $ = (selector) => document.querySelector(selector);

export async function api(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    let detail = await resp.text();
    try {
      detail = JSON.parse(detail).detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
  return resp.json();
}

export function postJson(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function wsUrl(path) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

// ---------------------------------------------------------------- 模型列表

export let models = [];

export const getModel = (id) => models.find((m) => m.id === id);

export async function loadModels() {
  models = await api('/api/models');
  document.dispatchEvent(new Event('models-changed'));
}

/** 用某一类模型填充下拉框；模型列表变化时自动刷新，并尽量保持原来的选择。 */
export function bindModelSelect(select, kind, { optional = false } = {}) {
  const fill = () => {
    const previous = select.value;
    const options = models.filter((m) => m.kind === kind).map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`);
    if (optional) options.unshift('<option value="">不使用（复读模式）</option>');
    if (!options.length) options.push('<option value="">（请先到「模型管理」添加模型）</option>');
    select.innerHTML = options.join('');
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
    select.dispatchEvent(new Event('change'));
  };
  document.addEventListener('models-changed', fill);
  fill();
}

// ---------------------------------------------------------------- 界面小函数

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

export function bindRange(input, label, format) {
  const update = () => (label.textContent = format(Number(input.value)));
  input.addEventListener('input', update);
  update();
}

export const fmtMs = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

/** 渲染一排指标卡片：items = [[标题, 值, 说明?], ...] */
export function renderMetrics(container, items) {
  container.innerHTML = items
    .map(([label, value, hint]) => `<div class="metric" title="${escapeHtml(hint || '')}"><div class="metric-value">${value ?? '—'}</div><div class="metric-label">${label}</div></div>`)
    .join('');
}

export function setMeter(el, db, active = false) {
  el.style.width = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`;
  el.classList.toggle('active', active);
}

/** 读取后端的 NDJSON 流（每行一个 JSON 事件）。 */
export async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

/** 打开 WebSocket，连接成功后先发一条 JSON 配置。 */
export function openSocket(path, config) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify(config));
      resolve(ws);
    };
    ws.onerror = () => reject(new Error('无法连接服务端 WebSocket'));
  });
}

// ---------------------------------------------------------------- 热词组件
// 热词保存在浏览器 localStorage（按模型分开），每次识别请求时随请求发给后端。

const HOTWORD_HINTS = {
  none: '该模型的「热词传递方式」是「不传」。到「模型管理」里按模型选择传法后才会生效。',
  field: '将以 hotwords 字段（逗号分隔）随每次请求发送。',
  prompt: '将写入 prompt 字段，作为模型上下文随每次请求发送。',
  funasr_json: '将以 {"词": 权重} 的 JSON 在连接建立时发送（需 SeACo/contextual 版 Paraformer）。',
  funasr_text: '将以空格分隔的文本在连接建立时发送。',
};

const loadHotwords = (modelId) => JSON.parse(localStorage.getItem(`hotwords:${modelId}`) || '[]');
const saveHotwords = (modelId, list) => localStorage.setItem(`hotwords:${modelId}`, JSON.stringify(list));

/** 在 container 里放一个热词管理面板，跟随 modelSelect 切换。返回 getHotwords()。 */
export function mountHotwords(container, modelSelect) {
  container.append($('#tpl-hotwords').content.cloneNode(true));
  const wordInput = container.querySelector('.hw-word');
  const weightInput = container.querySelector('.hw-weight');
  const listEl = container.querySelector('.hw-list');

  const getHotwords = () => (modelSelect.value ? loadHotwords(modelSelect.value) : []);

  const render = () => {
    const list = getHotwords();
    container.querySelector('.hw-count').textContent = list.length;
    container.querySelector('.hw-hint').textContent = HOTWORD_HINTS[getModel(modelSelect.value)?.hotword_mode ?? 'none'];
    listEl.innerHTML = list.length
      ? list.map((h, i) => `<span class="chip">${escapeHtml(h.word)}<em>${h.weight}</em><button data-i="${i}" aria-label="删除">×</button></span>`).join('')
      : '<span class="muted">暂无热词</span>';
  };

  const add = () => {
    const word = wordInput.value.trim();
    if (!word || !modelSelect.value) return;
    const list = getHotwords().filter((h) => h.word !== word);
    list.push({ word, weight: Number(weightInput.value) || 20 });
    saveHotwords(modelSelect.value, list);
    wordInput.value = '';
    render();
  };

  container.querySelector('.hw-add').addEventListener('click', add);
  wordInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  listEl.addEventListener('click', (e) => {
    const index = e.target.dataset?.i;
    if (index === undefined) return;
    const list = getHotwords();
    list.splice(Number(index), 1);
    saveHotwords(modelSelect.value, list);
    render();
  });
  modelSelect.addEventListener('change', render);
  render();
  return getHotwords;
}
