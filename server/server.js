// COURTSIDE server: static files, vendored browser libraries, HTTPS (self-signed or your own cert),
// WebSocket signalling for WebRTC camera pairing, QR codes, ICE/TURN config and match persistence.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import zlib from 'node:zlib';
import { MatchRegistry, attachPeer } from './signalling.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const DATA = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
const HTTP_PORT = +(env.HTTP_PORT ?? env.PORT ?? 8080), HTTPS_PORT = +(env.HTTPS_PORT ?? 8443);
const VENDOR = {
  '/vendor/tasks-vision/': 'node_modules/@mediapipe/tasks-vision/',
  '/vendor/ort/': 'node_modules/onnxruntime-web/dist/',
  '/vendor/tfjs/': 'node_modules/@tensorflow/tfjs/dist/',
  '/vendor/coco-ssd/': 'node_modules/@tensorflow-models/coco-ssd/dist/',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.onnx': 'application/octet-stream', '.task': 'application/octet-stream', '.bin': 'application/octet-stream', '.webm': 'video/webm', '.ico': 'image/x-icon' };

export function lanAddresses() { return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address); }

function iceServers() {
  const s = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',') }];
  if (env.TURN_URLS) s.push({ urls: env.TURN_URLS.split(','), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  return s;
}

async function tlsOptions() {
  if (env.CERT_FILE && env.KEY_FILE) return { cert: fs.readFileSync(env.CERT_FILE), key: fs.readFileSync(env.KEY_FILE), self: false };
  const dir = path.join(DATA, 'certs'), cf = path.join(dir, 'cert.pem'), kf = path.join(dir, 'key.pem');
  if (!fs.existsSync(cf)) {
    const selfsigned = (await import('selfsigned')).default; fs.mkdirSync(dir, { recursive: true });
    const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map(ip => ({ type: 7, ip }))];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'courtside.local' }], { days: 825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] });
    fs.writeFileSync(cf, pems.cert); fs.writeFileSync(kf, pems.private);
  }
  return { cert: fs.readFileSync(cf), key: fs.readFileSync(kf), self: true };
}

function readBody(req, limit) { return new Promise((res, rej) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > limit) { rej(new Error('too large')); req.destroy(); } else ch.push(d); }); req.on('end', () => res(Buffer.concat(ch))); req.on('error', rej); }); }

export function createApp({ registry, httpsPort = HTTPS_PORT }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname);
    // cross-origin isolation enables multi-threaded WASM inference (all assets are same-origin)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (p === '/api/info') return json(200, { lan: lanAddresses(), httpsPort, time: Date.now(), publicUrl: env.PUBLIC_URL || null });
      if (p === '/api/ice') return json(200, { iceServers: iceServers() });
      if (p === '/api/qr') { const svg = await QRCode.toString(String(url.searchParams.get('text') || '').slice(0, 1000), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(svg); }
      const mm = p.match(/^\/api\/matches\/([\w-]+)\/(log|clips)(?:\/([\w.-]+))?$/);
      if (mm) {
        const m = registry.matches.get(mm[1]); if (!m) return json(404, { error: 'no match' });
        const dir = path.join(DATA, 'matches', m.id); fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
        const authed = req.headers['x-host-token'] === m.hostToken;
        if (req.method === 'GET' && mm[2] === 'log') { if (!authed) return json(403, { error: 'forbidden' }); const f = path.join(dir, 'log.json'); return json(200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { events: [] }); }
        if (req.method === 'POST' && mm[2] === 'log') { if (!authed) return json(403, { error: 'forbidden' }); const body = JSON.parse((await readBody(req, 20e6)).toString()); fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(body)); return json(200, { ok: true }); }
        if (req.method === 'POST' && mm[2] === 'clips' && mm[3]) { if (!authed) return json(403, { error: 'forbidden' }); fs.writeFileSync(path.join(dir, 'clips', path.basename(mm[3])), await readBody(req, 80e6)); return json(200, { ok: true, url: `/api/matches/${m.id}/clips/${path.basename(mm[3])}` }); }
        if (req.method === 'GET' && mm[2] === 'clips' && mm[3]) { const f = path.join(dir, 'clips', path.basename(mm[3])); if (!fs.existsSync(f)) return json(404, {}); res.writeHead(200, { 'content-type': 'video/webm' }); return fs.createReadStream(f).pipe(res); }
        return json(405, { error: 'method' });
      }
      let file;
      const v = Object.keys(VENDOR).find(k => p.startsWith(k));
      if (v) file = path.join(ROOT, VENDOR[v], p.slice(v.length));
      else { if (p === '/') p = '/index.html'; file = path.join(ROOT, 'public', p); }
      const base = v ? path.join(ROOT, VENDOR[v]) : path.join(ROOT, 'public');
      if (!path.resolve(file).startsWith(path.resolve(base))) return json(403, { error: 'forbidden' });
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(404, { error: 'not found', path: p });
      // caching: validators on everything (304 when unchanged), long max-age for libraries/models
      const st = fs.statSync(file), etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': p.startsWith('/models/') || v ? 'public, max-age=604800' : 'no-cache', etag, 'last-modified': st.mtime.toUTCString(), vary: 'accept-encoding' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      // compress text assets (JS/CSS/HTML/JSON/SVG) — several MB less on slow hosts
      const textual = /\.(m?js|css|html|json|svg)$/.test(file) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (textual) { res.writeHead(200, { ...headers, 'content-encoding': 'gzip' }); return fs.createReadStream(file).pipe(zlib.createGzip({ level: 6 })).pipe(res); }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    } catch (e) { json(500, { error: e.message }); }
  };
}

export function attachWebSocket(server, registry, log) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
  wss.on('connection', ws => {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    const send = obj => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const peer = attachPeer(registry, send, log);
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch { return; } peer.onMessage(m); });
    ws.on('close', () => peer.onClose());
  });
  const iv = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, +(env.HEARTBEAT_MS || 10000));
  iv.unref?.(); server.on('close', () => { clearInterval(iv); wss.close(); });
  return wss;
}

export async function start({ quiet = false } = {}) {
  const log = quiet ? () => { } : (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const registry = new MatchRegistry({ dataDir: DATA });
  const app = createApp({ registry });
  const servers = [];
  const h = http.createServer(app); attachWebSocket(h, registry, log); await new Promise(r => h.listen(HTTP_PORT, r)); servers.push(h);
  let tls = null;
  if (env.DISABLE_HTTPS !== '1') { tls = await tlsOptions(); const s = https.createServer({ cert: tls.cert, key: tls.key }, app); attachWebSocket(s, registry, log); await new Promise(r => s.listen(HTTPS_PORT, r)); servers.push(s); }
  if (!quiet) {
    console.log('\n  COURTSIDE referee server running');
    console.log(`  Dashboard (this computer): http://localhost:${HTTP_PORT}`);
    if (tls) for (const ip of lanAddresses()) console.log(`  Phones on the same Wi-Fi:  https://${ip}:${HTTPS_PORT}  ${tls.self ? '(self-signed certificate: accept the warning once per device)' : ''}`);
    console.log('');
  }
  return { servers, registry, close: () => Promise.all(servers.map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r); }))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
