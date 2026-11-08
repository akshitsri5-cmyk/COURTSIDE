// Pairing, signalling relay, disconnection and reconnection over real WebSockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { MatchRegistry } from '../../server/signalling.js';
import { attachWebSocket, createApp } from '../../server/server.js';

async function setup() {
  const registry = new MatchRegistry(); const srv = http.createServer(createApp({ registry })); attachWebSocket(srv, registry, () => { });
  await new Promise(r => srv.listen(0, r)); const url = `ws://127.0.0.1:${srv.address().port}/ws`;
  return { registry, srv, url, port: srv.address().port };
}
function client(url) {
  const ws = new WebSocket(url), q = [], waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); const w = waiters.findIndex(x => x.f(m)); if (w >= 0) waiters.splice(w, 1)[0].r(m); else q.push(m); });
  return { ws, open: () => new Promise(r => ws.once('open', r)), send: m => ws.send(JSON.stringify(m)), next: (f = () => true, ms = 2000) => new Promise((r, j) => { const i = q.findIndex(f); if (i >= 0) return r(q.splice(i, 1)[0]); const w = { f, r }; waiters.push(w); setTimeout(() => j(new Error('timeout waiting for message')), ms); }), close: () => ws.close() };
}

test('host creates a match, camera pairs by 6-digit code and by QR link, signals are relayed both ways', async () => {
  const { srv, url } = await setup();
  const host = client(url); await host.open(); host.send({ type: 'hello', role: 'host', name: 'Test' });
  const w = await host.next(m => m.type === 'welcome'); assert.match(w.code, /^\d{6}$/);
  const cam = client(url); await cam.open(); cam.send({ type: 'hello', role: 'camera', code: w.code, label: 'Baseline' });
  const cw = await cam.next(m => m.type === 'welcome'); assert.ok(cw.cameraToken); assert.equal(cw.hostOnline, true);
  assert.equal((await host.next(m => m.type === 'camera-online')).cameraId, cw.cameraId);
  cam.send({ type: 'signal', data: { sdp: 'offer' } }); assert.deepEqual((await host.next(m => m.type === 'signal')).data, { sdp: 'offer' });
  host.send({ type: 'signal', to: cw.cameraId, data: { sdp: 'answer' } }); assert.equal((await cam.next(m => m.type === 'signal')).data.sdp, 'answer');
  const cam2 = client(url); await cam2.open(); cam2.send({ type: 'hello', role: 'camera', matchId: w.matchId, joinKey: w.joinKey });
  const c2 = await cam2.next(m => m.type === 'welcome'); assert.notEqual(c2.cameraId, cw.cameraId, 'second phone gets its own camera id');
  const bad = client(url); await bad.open(); bad.send({ type: 'hello', role: 'camera', code: '000000' }); assert.equal((await bad.next()).type, 'error');
  [host, cam, cam2, bad].forEach(c => c.close()); srv.closeAllConnections(); srv.close();
});

test('camera disconnect is reported; reconnect with token keeps the same camera id; host reconnect notifies cameras', async () => {
  const { srv, url } = await setup();
  const host = client(url); await host.open(); host.send({ type: 'hello', role: 'host' }); const w = await host.next(m => m.type === 'welcome');
  const cam = client(url); await cam.open(); cam.send({ type: 'hello', role: 'camera', code: w.code }); const cw = await cam.next(m => m.type === 'welcome');
  await host.next(m => m.type === 'camera-online'); cam.ws.terminate();
  assert.equal((await host.next(m => m.type === 'camera-offline')).cameraId, cw.cameraId);
  const again = client(url); await again.open(); again.send({ type: 'hello', role: 'camera', matchId: cw.matchId, cameraId: cw.cameraId, cameraToken: cw.cameraToken });
  assert.equal((await again.next(m => m.type === 'welcome')).cameraId, cw.cameraId);
  await host.next(m => m.type === 'camera-online');
  host.ws.terminate(); await again.next(m => m.type === 'host-offline');
  const host2 = client(url); await host2.open(); host2.send({ type: 'hello', role: 'host', matchId: w.matchId, hostToken: w.hostToken });
  const hw = await host2.next(m => m.type === 'welcome'); assert.equal(hw.cameras.length, 1);
  await again.next(m => m.type === 'host-online');
  const thief = client(url); await thief.open(); thief.send({ type: 'hello', role: 'host', matchId: w.matchId, hostToken: 'wrong' }); assert.equal((await thief.next()).code, 'bad-token');
  [host2, again, thief].forEach(c => c.close()); srv.closeAllConnections(); srv.close();
});

test('time sync endpoint and QR/ICE HTTP APIs', async () => {
  const { srv, url, port } = await setup();
  const c = client(url); await c.open(); const t0 = Date.now(); c.send({ type: 'time', t0 }); const r = await c.next(); assert.equal(r.t0, t0); assert.ok(Math.abs(r.ts - Date.now()) < 1000);
  const get = p => new Promise(res => http.get(`http://127.0.0.1:${port}${p}`, rs => { let b = ''; rs.on('data', d => b += d); rs.on('end', () => res({ status: rs.statusCode, body: b, type: rs.headers['content-type'] })); }));
  const q = await get('/api/qr?text=' + encodeURIComponent('https://x/camera.html?m=1')); assert.match(q.body, /<svg/);
  assert.ok(JSON.parse((await get('/api/ice')).body).iceServers.length >= 1);
  assert.equal((await get('/../package.json')).status === 200, false, 'path traversal blocked');
  c.close(); srv.closeAllConnections(); srv.close();
});
