// 本地模拟服务：无需 GPU 即可联调前端。
//   HTTP  /v1/audio/transcriptions  (OpenAI/vLLM 风格 ASR，支持 stream=true SSE)
//   HTTP  /v1/audio/speech          (OpenAI/vLLM-Omni 风格 TTS，支持 pcm 流式)
//   HTTP  /v1/chat/completions      (复读式 LLM，SSE)
//   HTTP  /v1/models
//   WS    ws://host:PORT            (FunASR runtime 2pass 协议)
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT || 9000);
const TTS_RATE = 24000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function field(raw, name) {
  const m = raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
  return m ? Buffer.from(m[1], 'latin1').toString('utf8') : undefined;
}

function makeTone(text, seconds) {
  const n = Math.floor(TTS_RATE * seconds);
  const out = Buffer.alloc(n * 2);
  const base = 220 + ((text.codePointAt(0) || 0) % 12) * 30;
  for (let i = 0; i < n; i++) {
    const t = i / TTS_RATE;
    const env = Math.min(1, t * 20, (seconds - t) * 20);
    const vib = 1 + 0.02 * Math.sin(2 * Math.PI * 5 * t);
    const v = Math.sin(2 * Math.PI * base * vib * t) * 0.35 * env;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

function wavHeader(dataLen, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

async function handleAsr(req, res) {
  const body = await readBody(req);
  const raw = body.toString('latin1');
  const stream = field(raw, 'stream') === 'true';
  const hot = field(raw, 'hotwords') || field(raw, 'prompt');
  const text = `这是模拟的识别结果，收到音频 ${body.length} 字节${hot ? `，热词：${hot}` : ''}。`;
  if (!stream) return json(res, 200, { text });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  await sleep(300);
  for (const ch of Array.from(text)) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    await sleep(60);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleTts(req, res) {
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  const input = String(body.input || '');
  const seconds = Math.max(0.6, Math.min(20, Array.from(input).length * 0.18));
  const pcm = makeTone(input, seconds);
  const format = body.response_format || 'wav';
  await sleep(350);
  if (format === 'pcm') {
    res.writeHead(200, { 'content-type': 'audio/pcm', 'transfer-encoding': 'chunked' });
    const step = TTS_RATE * 2 * 0.1;
    for (let i = 0; i < pcm.length; i += step) {
      res.write(pcm.subarray(i, Math.min(pcm.length, i + step)));
      await sleep(body.stream ? 60 : 0);
    }
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'audio/wav' });
  res.end(Buffer.concat([wavHeader(pcm.length, TTS_RATE), pcm]));
}

async function handleChat(req, res) {
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const reply = `你说的是：${last?.content ?? ''}。这是模拟大模型的回复，用来测试通话链路。`;
  if (!body.stream) {
    return json(res, 200, { choices: [{ message: { role: 'assistant', content: reply } }] });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  await sleep(200);
  for (const part of reply.match(/.{1,4}/gs) || []) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    await sleep(40);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.endsWith('/models')) return json(res, 200, { data: [{ id: 'mock-model' }] });
    if (pathname.endsWith('/audio/transcriptions')) return await handleAsr(req, res);
    if (pathname.endsWith('/audio/speech')) return await handleTts(req, res);
    if (pathname.endsWith('/chat/completions')) return await handleChat(req, res);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let cfg = { mode: '2pass', hotwords: '' };
  let bytes = 0;
  let sinceLast = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bytes += data.length;
      sinceLast += data.length;
      if (sinceLast >= 16000 * 2 * 0.6 && cfg.mode !== 'offline') {
        sinceLast = 0;
        ws.send(JSON.stringify({ mode: cfg.mode === 'online' ? 'online' : '2pass-online', text: '模拟', wav_name: cfg.wav_name, is_final: false }));
      }
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.mode) cfg = { ...cfg, ...msg };
    if (msg.is_speaking === false) {
      const text = `这是模拟的实时识别结果，共收到 ${bytes} 字节${cfg.hotwords && cfg.hotwords !== '{}' ? `，热词 ${cfg.hotwords}` : ''}。`;
      const mode = cfg.mode === '2pass' ? '2pass-offline' : cfg.mode;
      ws.send(
        JSON.stringify({
          mode,
          text,
          wav_name: cfg.wav_name,
          is_final: true,
          timestamp: '[[0,500],[500,1000]]',
          stamp_sents: [{ text_seg: text, start: 0, end: Math.round(bytes / 32), spk: 0 }],
        }),
      );
      bytes = 0;
      sinceLast = 0;
    }
  });
});

server.listen(PORT, () => console.log(`mock model server on http://localhost:${PORT} (HTTP + FunASR WS)`));
