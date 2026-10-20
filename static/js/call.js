// 语音通话页：麦克风 PCM 发给后端，后端跑完 VAD -> ASR -> LLM -> TTS，把声音（PCM）和文字事件发回来。
// 这里只负责：发麦克风、播放收到的 PCM、显示文字和指标。
import { MicStream, PcmPlayer } from './audio.js';
import { $, bindModelSelect, escapeHtml, fmtMs, mountHotwords, openSocket, renderMetrics, setMeter, showError } from './common.js';

const asrSelect = $('#call-asr');
const getHotwords = mountHotwords($('#call-hotwords'), asrSelect);
bindModelSelect(asrSelect, 'asr');
bindModelSelect($('#call-tts'), 'tts');
bindModelSelect($('#call-llm'), 'llm', { optional: true });
renderMetrics($('#call-metrics'), []);

const STATE_TEXT = { listening: '聆听中…', thinking: '思考中…', speaking: '正在说话…' };

const mic = new MicStream();
let socket = null;
let player = null;
let callTimer = null;
let assistantBubble = null;

$('#call-start').addEventListener('click', async () => {
  if (!asrSelect.value || !$('#call-tts').value) return;
  showError($('#call-error'), '');
  $('#call-chat').innerHTML = '';
  renderMetrics($('#call-metrics'), []);
  try {
    socket = await openSocket('/ws/call', {
      asr_id: asrSelect.value,
      tts_id: $('#call-tts').value,
      llm_id: $('#call-llm').value,
      system_prompt: $('#call-prompt').value,
      barge_in: $('#call-barge').checked,
      hotwords: getHotwords(),
    });
    socket.onmessage = onMessage;
    socket.onclose = hangup;
    await mic.start((pcm) => socket?.readyState === WebSocket.OPEN && socket.send(pcm));
    $('#call-start').hidden = true;
    $('#call-stop').hidden = false;
    const t0 = Date.now();
    callTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('#call-time').textContent = `通话时长 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  } catch (err) {
    mic.stop();
    socket?.close();
    showError($('#call-error'), err.message);
  }
});

$('#call-stop').addEventListener('click', () => {
  socket?.send(JSON.stringify({ type: 'stop' }));
  hangup();
});

function hangup() {
  mic.stop();
  socket?.close();
  socket = null;
  player?.close();
  player = null;
  clearInterval(callTimer);
  $('#call-start').hidden = false;
  $('#call-stop').hidden = true;
  $('#call-time').textContent = '点击拨打开始通话';
  $('#call-state').textContent = '未接通';
  $('#call-card').className = 'call-card';
  setMeter($('#call-meter'), -70);
}

function onMessage(e) {
  // 二进制消息 = AI 说话的 PCM，直接送去播放
  if (e.data instanceof ArrayBuffer) {
    player?.push(e.data);
    return;
  }
  const event = JSON.parse(e.data);
  switch (event.type) {
    case 'state':
      $('#call-state').textContent = STATE_TEXT[event.state] ?? event.state;
      $('#call-card').className = `call-card ${event.state}`;
      break;
    case 'level':
      setMeter($('#call-meter'), event.db, event.speaking);
      break;
    case 'user_text':
      assistantBubble = null;
      addBubble('user', event.text);
      break;
    case 'assistant_text':
      if (!assistantBubble) assistantBubble = addBubble('assistant', '');
      assistantBubble.firstChild.textContent = event.text;
      if (event.note) assistantBubble.insertAdjacentHTML('beforeend', `<em>${escapeHtml(event.note)}</em>`);
      break;
    case 'audio_start':
      player?.close();
      player = new PcmPlayer(event.sample_rate);
      break;
    case 'clear': // 被用户打断：立刻停止播放
      player?.clear();
      break;
    case 'interrupted':
      assistantBubble?.insertAdjacentHTML('beforeend', '<em>（已被打断）</em>');
      break;
    case 'metrics':
      renderMetrics($('#call-metrics'), [
        ['ASR 识别', fmtMs(event.asr_ms)],
        ['LLM 首字', fmtMs(event.llm_first_ms)],
        ['TTS 首包', fmtMs(event.tts_first_ms)],
        ['端到端', fmtMs(event.e2e_ms), '用户语音段结束 → 听到 AI 第一个声音（含 VAD 静音等待）'],
      ]);
      break;
    case 'error':
      showError($('#call-error'), event.message);
      break;
  }
}

function addBubble(role, text) {
  const chat = $('#call-chat');
  if (chat.firstElementChild?.classList.contains('muted')) chat.innerHTML = '';
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.append(document.createTextNode(text));
  chat.append(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}
