// 模型管理页：增删改模型、一键模板、测试连接。数据都存在后端（data/models.json）。
import { $, api, escapeHtml, loadModels, models, postJson, showError } from './common.js';

const PROTOCOLS = {
  asr: [['openai_transcriptions', 'vLLM：/v1/audio/transcriptions'], ['funasr_ws', 'FunASR WebSocket']],
  tts: [['openai_speech', 'vLLM-Omni：/v1/audio/speech']],
  llm: [['openai_chat', 'vLLM：/v1/chat/completions']],
};
const KIND_NAME = { asr: 'ASR', tts: 'TTS', llm: 'LLM' };

let editing = null; // 正在编辑的模型对象（新建时 id 为空）

// ---------------------------------------------------------------- 列表与模板

async function renderPresets() {
  const presets = await api('/api/presets');
  $('#model-presets').innerHTML = presets.map((p, i) => `<button data-i="${i}">+ ${escapeHtml(p.name)}</button>`).join('');
  $('#model-presets').onclick = (e) => {
    const i = e.target.dataset?.i;
    if (i !== undefined) openEditor({ ...presets[i] });
  };
}

function renderTable() {
  $('#model-table').innerHTML = models.length
    ? models
        .map(
          (m) => `<tr>
            <td><span class="badge kind-${m.kind}">${KIND_NAME[m.kind]}</span></td>
            <td>${escapeHtml(m.name)}</td><td>${m.protocol}</td><td class="mono">${escapeHtml(m.base_url)}</td>
            <td class="row"><button data-edit="${m.id}">编辑</button><button data-delete="${m.id}">删除</button></td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">还没有模型。点上面的模板开始添加；本地联调可先运行 <code>python mock_server.py</code>，地址填 http://127.0.0.1:9000（FunASR 填 ws://127.0.0.1:9000）。</td></tr>';
}

$('#model-table').addEventListener('click', async (e) => {
  const { edit, delete: del } = e.target.dataset;
  if (edit) openEditor({ ...models.find((m) => m.id === edit) });
  if (del && confirm('确定删除这个模型？')) {
    await api(`/api/models/${del}`, { method: 'DELETE' });
    await loadModels();
  }
});

document.addEventListener('models-changed', renderTable);

// ---------------------------------------------------------------- 编辑表单

function openEditor(model) {
  editing = model;
  $('#model-editor').hidden = false;
  $('#model-editor-title').textContent = model.id ? `编辑 ${KIND_NAME[model.kind]} 模型` : `新增 ${KIND_NAME[model.kind]} 模型`;
  $('#m-protocol').innerHTML = PROTOCOLS[model.kind].map(([v, label]) => `<option value="${v}">${label}</option>`).join('');

  $('#m-name').value = model.name;
  $('#m-protocol').value = model.protocol;
  $('#m-base-url').value = model.base_url;
  $('#m-api-key').value = model.api_key || '';
  $('#m-model').value = model.model || '';
  $('#m-hotword-mode').value = model.hotword_mode || 'none';
  $('#m-funasr-mode').value = model.funasr_mode || '2pass';
  $('#m-sample-rate').value = model.tts_sample_rate || 24000;
  $('#m-voice').value = model.default_voice || '';
  $('#m-streaming').checked = !!model.streaming;
  $('#m-has-vad').checked = !!model.has_vad;
  $('#m-has-punc').checked = !!model.has_punc;
  $('#m-has-speaker').checked = !!model.has_speaker;
  $('#m-extra').value = Object.keys(model.extra || {}).length ? JSON.stringify(model.extra, null, 2) : '';
  $('#m-test-result').textContent = '';
  showError($('#m-error'), '');
  syncVisibility();
  $('#model-editor').scrollIntoView({ behavior: 'smooth' });
}

/** 按模型类型/协议显示或隐藏相关字段 */
function syncVisibility() {
  const kind = editing.kind;
  const protocol = $('#m-protocol').value;
  const show = { asr: kind === 'asr', tts: kind === 'tts', funasr: protocol === 'funasr_ws', http: protocol !== 'funasr_ws' };
  document.querySelectorAll('#model-editor [data-show]').forEach((el) => (el.hidden = !show[el.dataset.show]));
}
$('#m-protocol').addEventListener('change', syncVisibility);

function readForm() {
  let extra = {};
  const raw = $('#m-extra').value.trim();
  if (raw) {
    try {
      extra = JSON.parse(raw);
    } catch {
      throw new Error('「额外请求参数」不是合法的 JSON');
    }
  }
  return {
    ...editing,
    name: $('#m-name').value.trim(),
    protocol: $('#m-protocol').value,
    base_url: $('#m-base-url').value.trim(),
    api_key: $('#m-api-key').value,
    model: $('#m-model').value.trim(),
    hotword_mode: $('#m-hotword-mode').value,
    funasr_mode: $('#m-funasr-mode').value,
    tts_sample_rate: Number($('#m-sample-rate').value) || 24000,
    default_voice: $('#m-voice').value.trim(),
    streaming: $('#m-streaming').checked,
    has_vad: $('#m-has-vad').checked,
    has_punc: $('#m-has-punc').checked,
    has_speaker: $('#m-has-speaker').checked,
    extra,
  };
}

$('#m-save').addEventListener('click', async () => {
  try {
    const model = readForm();
    if (!model.name || !model.base_url) throw new Error('名称和服务地址不能为空');
    await postJson('/api/models', model);
    $('#model-editor').hidden = true;
    await loadModels();
  } catch (err) {
    showError($('#m-error'), err.message);
  }
});

$('#m-test').addEventListener('click', async () => {
  const result = $('#m-test-result');
  result.textContent = '测试中…';
  result.className = '';
  try {
    const r = await postJson('/api/models/test', readForm());
    result.textContent = r.message;
    result.className = r.ok ? 'ok' : 'bad';
  } catch (err) {
    result.textContent = err.message;
    result.className = 'bad';
  }
});

$('#m-cancel').addEventListener('click', () => ($('#model-editor').hidden = true));

renderPresets();
renderTable();
