import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INSECURE_TLS = process.env.INSECURE_TLS === '1';
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

const SKIP_REQ_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'upgrade',
]);
const SKIP_RES_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function parseTarget(raw, protocols) {
  if (!raw) return { error: 'missing url parameter' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid url' };
  }
  if (!protocols.includes(url.protocol)) return { error: `unsupported protocol ${url.protocol}` };
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(url.hostname) && !ALLOWED_HOSTS.includes(url.host)) {
    return { error: `host ${url.host} is not in ALLOWED_HOSTS` };
  }
  return { url };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handleProxy(req, res, reqUrl) {
  const { url, error } = parseTarget(reqUrl.searchParams.get('url'), ['http:', 'https:']);
  if (error) return sendJson(res, 400, { error });

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP_REQ_HEADERS.has(k) || k.startsWith('sec-')) continue;
    headers[k] = v;
  }
  headers['accept-encoding'] = 'identity';

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });

  const init = { method: req.method, headers, signal: ac.signal, redirect: 'follow' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    if (ac.signal.aborted) return;
    const detail = e?.cause?.message || e?.message || String(e);
    return sendJson(res, 502, { error: `cannot reach ${url.host}: ${detail}` });
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!SKIP_RES_HEADERS.has(k)) outHeaders[k] = v;
  });
  outHeaders['x-accel-buffering'] = 'no';
  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders?.();

  if (!upstream.body) return res.end();
  try {
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      if (!res.write(chunk)) await once(res, 'drain');
    }
  } catch {
    // client went away or upstream aborted mid-stream
  }
  res.end();
}

function serveStatic(req, res, reqUrl) {
  if (!fs.existsSync(WEB_DIR)) {
    return sendJson(res, 404, { error: 'web/dist not found. Run `npm run build` or use `npm run dev`.' });
  }
  const rel = decodeURIComponent(reqUrl.pathname);
  let file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (reqUrl.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (reqUrl.pathname === '/api/proxy') {
    handleProxy(req, res, reqUrl).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
      else res.end();
    });
    return;
  }
  serveStatic(req, res, reqUrl);
});

const wss = new WebSocketServer({ noServer: true });

function safeClose(ws, code, reason) {
  const valid = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
  try {
    ws.close(valid ? code : 1000, String(reason || '').slice(0, 120));
  } catch {
    ws.terminate();
  }
}

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (reqUrl.pathname !== '/api/ws-proxy') {
    socket.destroy();
    return;
  }
  const { url, error } = parseTarget(reqUrl.searchParams.get('url'), ['ws:', 'wss:']);
  if (error) {
    socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${error}`);
    socket.destroy();
    return;
  }
  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(reqUrl.searchParams.get('headers') || '{}');
  } catch {
    extraHeaders = {};
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(url, { headers: extraHeaders, rejectUnauthorized: !INSECURE_TLS });
    const pending = [];

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    client.on('close', () => upstream.close());
    client.on('error', () => upstream.terminate());

    upstream.on('open', () => {
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => safeClose(client, code, reason.toString()));
    upstream.on('error', (e) => safeClose(client, 1011, `upstream error: ${e.message}`));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`voice-playground server listening on http://${HOST}:${PORT}`);
  if (ALLOWED_HOSTS.length) console.log(`proxy restricted to: ${ALLOWED_HOSTS.join(', ')}`);
});
