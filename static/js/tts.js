// 语音合成页：向后端请求 PCM 流，边收边播，并记录「首包延迟」。
import { PcmPlayer } from './audio.js';
import { $, bindModelSelect, bindRange, escapeHtml, fmtMs, getModel, renderMetrics, showError } from './common.js';

const modelSelect = $('#tts-model');
bindModelSelect(modelSelect, 'tts');
bindRange($('#tts-speed'), $('#tts-speed-label'), (v) => `${v.toFixed(1)}x`);
renderMetrics($('#tts-metrics'), []);

modelSelect.addEventListener('change', () => {
  $('#tts-voice').placeholder = getModel(modelSelect.value)?.default_voice || '留空用模型默认';
});

let player = null;
let abort = null;
let historyCount = 0;

$('#tts-run').addEventListener('click', synthesize);
$('#tts-stop').addEventListener('click', () => {
  abort?.abort();
  player?.close();
});

async function synthesize() {
  const text = $('#tts-text').value.trim();
  if (!text || !modelSelect.value) return;
  player?.close();
  abort = new AbortController();
  showError($('#tts-error'), '');
  $('#tts-run').disabled = true;
  $('#tts-stop').hidden = false;

  $('#tts-ttfb').textContent = '计时中…';
  const t0 = performance.now(); // 计时起点：点击合成
  const metrics = {};
  try {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelSelect.value,
        text,
        voice: $('#tts-voice').value.trim(),
        speed: Number($('#tts-speed').value),
        stream: $('#tts-stream').checked,
      }),
      signal: abort.signal,
    });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || `请求失败 ${resp.status}`);
    metrics.headers = performance.now() - t0;

    const sampleRate = Number(resp.headers.get('X-Sample-Rate'));
    const audioId = resp.headers.get('X-Audio-Id');
    player = new PcmPlayer(sampleRate);
    let totalBytes = 0;

    // 一块一块读 PCM：第一块到达的时刻就是「首包延迟」
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.length) continue;
      if (metrics.firstChunk === undefined) {
        metrics.firstChunk = performance.now() - t0;
        $('#tts-ttfb').textContent = fmtMs(metrics.firstChunk);
      }
      totalBytes += value.length;
      player.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.length));
      if (metrics.firstPlay === undefined && player.firstPlayAt) metrics.firstPlay = player.firstPlayAt - t0;
      showMetrics(metrics, t0, totalBytes, sampleRate, false);
    }
    metrics.total = performance.now() - t0;
    showMetrics(metrics, t0, totalBytes, sampleRate, true);
    addResult(audioId, text, metrics.firstChunk);
    await player.finished();
  } catch (err) {
    if (err.name !== 'AbortError') showError($('#tts-error'), err.message);
    if (metrics.firstChunk === undefined) $('#tts-ttfb').textContent = '—';
  } finally {
    $('#tts-run').disabled = false;
    $('#tts-stop').hidden = true;
  }
}

function showMetrics(m, t0, bytes, sampleRate, done) {
  const audioSec = bytes / 2 / sampleRate;
  const total = done ? m.total : undefined;
  renderMetrics($('#tts-metrics'), [
    ['响应头', fmtMs(m.headers), '点击合成 → 收到 HTTP 响应头'],
    ['首声音', fmtMs(m.firstPlay), '点击合成 → 第一个采样送入播放（不含声卡输出延迟）'],
    ['总耗时', fmtMs(total)],
    ['音频时长', `${audioSec.toFixed(2)} s`],
    ['RTF', total ? (total / 1000 / audioSec).toFixed(3) : '—', '生成耗时 / 音频时长，小于 1 才能无卡顿流式播放'],
  ]);
}

/** 合成完成：后端已把整段存成 WAV，页面里可以整体回放、下载。 */
function addResult(audioId, text, firstChunk) {
  const url = `/api/tts/files/${audioId}.wav`;
  $('#tts-empty').hidden = true;
  $('#tts-audio').src = url;
  $('#tts-audio').hidden = false;
  $('#tts-download').href = url;
  $('#tts-download').hidden = false;

  const li = document.createElement('li');
  li.innerHTML = `<div class="history-head"><span>#${++historyCount} ${new Date().toLocaleTimeString()}</span><span class="muted">TTFB ${fmtMs(firstChunk)}</span><a href="${url}" download>下载</a></div><p>${escapeHtml(text)}</p><audio controls src="${url}"></audio>`;
  $('#tts-history').prepend(li);
}
