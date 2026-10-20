// 语音唤醒页：把麦克风 PCM 持续发给后端，后端负责 VAD、ASR、唤醒词判断，这里只负责展示。
import { MicStream } from './audio.js';
import { $, bindModelSelect, bindRange, escapeHtml, fmtMs, mountHotwords, openSocket, setMeter, showError } from './common.js';

const modelSelect = $('#wake-model');
const getHotwords = mountHotwords($('#wake-hotwords'), modelSelect);
bindModelSelect(modelSelect, 'asr');
bindRange($('#wake-fuzzy'), $('#wake-fuzzy-label'), (v) => `${Math.round(v * 100)}%`);
bindRange($('#wake-awake'), $('#wake-awake-label'), (v) => `${v}s`);
bindRange($('#wake-sens'), $('#wake-sens-label'), (v) => v);

const mic = new MicStream();
let socket = null;
let countdown = null;

const wakeWords = () => $('#wake-words').value.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean);

$('#wake-start').addEventListener('click', async () => {
  if (!modelSelect.value) return;
  showError($('#wake-error'), '');
  $('#wake-transcript').innerHTML = '';
  try {
    socket = await openSocket('/ws/wake', {
      model_id: modelSelect.value,
      wake_words: wakeWords(),
      fuzzy: Number($('#wake-fuzzy').value),
      awake_sec: Number($('#wake-awake').value),
      sensitivity: Number($('#wake-sens').value),
      hotwords: getHotwords(),
    });
    socket.onmessage = (e) => onEvent(JSON.parse(e.data));
    socket.onclose = () => stop();
    await mic.start((pcm) => socket?.readyState === WebSocket.OPEN && socket.send(pcm));
    $('#wake-start').hidden = true;
    $('#wake-stop').hidden = false;
  } catch (err) {
    mic.stop();
    socket?.close();
    showError($('#wake-error'), err.message);
  }
});

$('#wake-stop').addEventListener('click', () => {
  socket?.send(JSON.stringify({ type: 'stop' }));
  stop();
});

function stop() {
  mic.stop();
  socket?.close();
  socket = null;
  clearInterval(countdown);
  $('#wake-start').hidden = false;
  $('#wake-stop').hidden = true;
  setMeter($('#wake-meter'), -70);
  setStatus('off', '未开始', '点击开始后实时监听麦克风');
}

function setStatus(state, title, sub) {
  $('#wake-status').className = `wake-status ${state}`;
  $('#wake-status-title').textContent = title;
  $('#wake-status-sub').textContent = sub;
}

/** 后端事件：state 状态变化 / level 音量 / log 一句话的识别情况 / wake 命中 / transcript 唤醒后的文字 */
function onEvent(event) {
  switch (event.type) {
    case 'state':
      clearInterval(countdown);
      if (event.state === 'sleeping') {
        setStatus('sleeping', '待机监听中…', `请说：${wakeWords().join(' / ')}`);
      } else {
        const until = Date.now() + event.awake_sec * 1000;
        const tick = () => setStatus('awake', `已唤醒 · ${Math.max(0, Math.round((until - Date.now()) / 1000))}s 后待机`, '现在说的内容会被识别');
        tick();
        countdown = setInterval(tick, 500);
      }
      break;
    case 'level':
      setMeter($('#wake-meter'), event.db, event.speaking);
      break;
    case 'wake':
      addTranscript(`【已唤醒：${event.word}】`);
      break;
    case 'transcript':
      addTranscript(event.text);
      break;
    case 'log':
      addLog(event);
      break;
    case 'error':
      showError($('#wake-error'), event.message);
      break;
  }
}

function addTranscript(text) {
  const p = document.createElement('p');
  p.textContent = text;
  $('#wake-transcript').append(p);
}

function addLog({ text, hit, ms }) {
  const log = $('#wake-log');
  if (log.firstElementChild?.classList.contains('muted')) log.innerHTML = '';
  const li = document.createElement('li');
  li.className = hit ? 'hit' : '';
  li.innerHTML = `<span class="muted">${new Date().toLocaleTimeString()}</span><span class="log-text">${escapeHtml(text)}</span><span class="muted">${fmtMs(ms)}</span>${hit ? '<span class="badge on">命中唤醒词</span>' : ''}`;
  log.prepend(li);
  while (log.children.length > 50) log.lastChild.remove();
}
