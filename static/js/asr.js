// 语音识别页：上传文件（HTTP）或麦克风（WebSocket），结果由后端流式返回。
import { MicStream, pcmLevelDb, pcmToWavBlob } from './audio.js';
import { $, bindModelSelect, escapeHtml, fmtMs, getModel, mountHotwords, openSocket, readNdjson, renderMetrics, setMeter, showError } from './common.js';

const modelSelect = $('#asr-model');
const streamBox = $('#asr-stream');
const textEl = $('#asr-text');
const getHotwords = mountHotwords($('#asr-hotwords'), modelSelect);

bindModelSelect(modelSelect, 'asr');

let busy = false;

// ---------------------------------------------------------------- 模型切换时刷新提示

modelSelect.addEventListener('change', () => {
  const m = getModel(modelSelect.value);
  if (!m) return;
  const caps = [['流式', m.streaming], ['服务端 VAD', m.has_vad], ['标点', m.has_punc], ['声纹/说话人', m.has_speaker]];
  $('#asr-badges').innerHTML = caps.map(([name, on]) => `<span class="badge ${on ? 'on' : ''}">${name}</span>`).join('');
  streamBox.disabled = !m.streaming;
  if (!m.streaming) streamBox.checked = false;
  $('#asr-hint').textContent = m.has_vad ? '服务端已部署 VAD，长音频由服务端自动切分。' : '服务端未声明 VAD：长音频建议先在本地切分。';
  $('#asr-mic-hint').textContent =
    m.protocol === 'funasr_ws'
      ? '实时模式：边说边识别，点击停止后给出最终结果。'
      : '录制模式：点击停止后整段发送识别' + (m.streaming ? '，结果流式返回。' : '。');
});

// ---------------------------------------------------------------- 显示结果

function resetResult() {
  showError($('#asr-error'), '');
  textEl.textContent = '';
  renderMetrics($('#asr-metrics'), []);
  $('#asr-segments').hidden = true;
}

/** 处理后端发来的事件：partial 中间结果 / final 最终结果 / error 出错 */
function onEvent(event) {
  if (event.type === 'partial') {
    textEl.textContent = event.text;
  } else if (event.type === 'final') {
    textEl.textContent = event.text;
    const rows = [
      ['首字延迟', fmtMs(event.first_token_ms), '从请求发出到收到第一个识别字'],
      ['总耗时', fmtMs(event.total_ms ?? event.finish_ms), event.finish_ms != null ? '点击停止后到拿到最终结果' : ''],
      ['音频时长', event.audio_sec ? `${event.audio_sec.toFixed(1)} s` : '—'],
      ['RTF', event.rtf ? event.rtf.toFixed(3) : '—', '总耗时 / 音频时长，越小越快'],
    ];
    renderMetrics($('#asr-metrics'), event.first_token_ms == null ? rows.filter((r) => r[0] !== '首字延迟' && r[0] !== 'RTF') : rows);
    renderSegments(event.segments || []);
  } else if (event.type === 'error') {
    showError($('#asr-error'), event.message);
  }
}

function renderSegments(segments) {
  $('#asr-segments').hidden = !segments.length;
  $('#asr-segments tbody').innerHTML = segments
    .map((s) => {
      const time = s.start != null ? `${s.start.toFixed(1)}–${(s.end ?? 0).toFixed(1)}s` : '—';
      return `<tr><td>${time}</td><td>${s.spk != null ? 'SPK' + s.spk : '—'}</td><td>${escapeHtml(s.text)}</td></tr>`;
    })
    .join('');
}

// ---------------------------------------------------------------- 来源切换：文件 / 麦克风

$('#asr-source-tabs').addEventListener('click', (e) => {
  const source = e.target.dataset?.source;
  if (!source) return;
  document.querySelectorAll('#asr-source-tabs button').forEach((b) => b.classList.toggle('active', b === e.target));
  $('#asr-source-file').hidden = source !== 'file';
  $('#asr-source-mic').hidden = source !== 'mic';
});

// ---------------------------------------------------------------- 上传文件

$('#asr-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    $('#asr-audio').src = URL.createObjectURL(file);
    $('#asr-audio').hidden = false;
  }
});

$('#asr-run').addEventListener('click', async () => {
  const file = $('#asr-file').files[0];
  if (!file || !modelSelect.value || busy) return;
  busy = true;
  $('#asr-run').textContent = '识别中…';
  resetResult();

  const form = new FormData();
  form.append('file', file);
  form.append('model_id', modelSelect.value);
  form.append('language', $('#asr-language').value.trim());
  form.append('stream', streamBox.checked);
  form.append('hotwords', JSON.stringify(getHotwords()));
  try {
    const resp = await fetch('/api/asr/file', { method: 'POST', body: form });
    if (!resp.ok) throw new Error(await resp.text());
    await readNdjson(resp, onEvent);
  } catch (err) {
    showError($('#asr-error'), err.message);
  } finally {
    busy = false;
    $('#asr-run').textContent = '开始识别';
  }
});

// ---------------------------------------------------------------- 麦克风

const mic = new MicStream();
let socket = null;
let recordedChunks = [];
let timer = null;

$('#asr-rec-start').addEventListener('click', async () => {
  if (!modelSelect.value || busy) return;
  resetResult();
  recordedChunks = [];
  try {
    socket = await openSocket('/ws/asr', {
      model_id: modelSelect.value,
      language: $('#asr-language').value.trim(),
      stream: streamBox.checked,
      hotwords: getHotwords(),
    });
    socket.onmessage = (e) => {
      const event = JSON.parse(e.data);
      onEvent(event);
      if (event.type === 'final' || event.type === 'error') setRecording(false);
    };
    await mic.start((pcm) => {
      recordedChunks.push(pcm);
      socket.send(pcm);
      setMeter($('#asr-meter'), pcmLevelDb(pcm), true);
    });
    setRecording(true);
  } catch (err) {
    mic.stop();
    socket?.close();
    showError($('#asr-error'), err.message);
  }
});

$('#asr-rec-stop').addEventListener('click', () => {
  mic.stop();
  socket.send(JSON.stringify({ type: 'stop' }));
  setMeter($('#asr-meter'), -70);
  $('#asr-rec-stop').disabled = true;
  $('#asr-rec-time').textContent = '识别中…';
  if (recordedChunks.length) {
    $('#asr-audio').src = URL.createObjectURL(pcmToWavBlob(recordedChunks));
    $('#asr-audio').hidden = false;
  }
});

function setRecording(on) {
  $('#asr-rec-start').hidden = on;
  $('#asr-rec-stop').hidden = !on;
  $('#asr-rec-stop').disabled = false;
  $('#asr-rec-time').hidden = !on;
  clearInterval(timer);
  if (on) {
    const t0 = Date.now();
    timer = setInterval(() => ($('#asr-rec-time').textContent = `录音中 ${((Date.now() - t0) / 1000).toFixed(1)}s`), 200);
  }
}

$('#asr-copy').addEventListener('click', () => navigator.clipboard?.writeText(textEl.textContent));
