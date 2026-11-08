// Signalling + match registry (transport-agnostic; the WebSocket layer is in server.js).
// One HOST (referee dashboard) per match, any number of CAMERA devices. Cameras/hosts receive tokens
// so they can reconnect after network drops or page reloads and keep their identity.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
export class MatchRegistry {
  constructor({ dataDir = null } = {}) { this.matches = new Map(); this.dataDir = dataDir; this.load(); }
  load() {
    if (!this.dataDir) return; const dir = path.join(this.dataDir, 'matches'); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.meta.json')) { try { const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); m.cameras = new Map(m.cameras); m.host = null; for (const c of m.cameras.values()) c.conn = null; this.matches.set(m.id, m); } catch { } }
  }
  save(m) {
    if (!this.dataDir) return; const { host, ...rest } = m;
    const data = { ...rest, cameras: [...m.cameras].map(([k, c]) => [k, { ...c, conn: null }]) };
    fs.writeFileSync(path.join(this.dataDir, 'matches', m.id + '.meta.json'), JSON.stringify(data, null, 1));
  }
  newCode() { let c; do { c = String(crypto.randomInt(100000, 1000000)); } while ([...this.matches.values()].some(m => m.code === c)); return c; }
  create(name = 'Match') {
    const m = { id: rid(6), name, code: this.newCode(), joinKey: rid(12), hostToken: rid(18), created: Date.now(), cameras: new Map(), host: null, nextCam: 1 };
    this.matches.set(m.id, m); this.save(m); return m;
  }
  byCode(code) { return [...this.matches.values()].find(m => m.code === String(code)); }
}

/** Handles one connection. send(obj) delivers to this peer; returns {onMessage, onClose}. */
export function attachPeer(reg, send, log = () => { }) {
  let me = null; // {match, role, cameraId}
  const sendTo = (m, to, msg) => { const c = to === 'host' ? m.host : m.cameras.get(to)?.conn; if (c) c(msg); return !!c; };
  const cameraList = m => [...m.cameras.values()].map(c => ({ cameraId: c.id, label: c.label, online: !!c.conn }));
  function onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'time') return send({ type: 'time', t0: msg.t0, ts: Date.now() });
    if (msg.type === 'hello') {
      if (msg.role === 'host') {
        let m = msg.matchId && reg.matches.get(msg.matchId);
        if (m && m.hostToken !== msg.hostToken) return send({ type: 'error', code: 'bad-token', message: 'Not the host of this match' });
        if (!m) m = reg.create(String(msg.name || 'Match').slice(0, 60));
        if (m.host) m.host({ type: 'error', code: 'replaced', message: 'Dashboard opened elsewhere' });
        m.host = send; me = { match: m, role: 'host' };
        send({ type: 'welcome', role: 'host', matchId: m.id, name: m.name, code: m.code, joinKey: m.joinKey, hostToken: m.hostToken, cameras: cameraList(m) });
        for (const c of m.cameras.values()) c.conn?.({ type: 'host-online' });
        log(`host connected to ${m.id}`); return;
      }
      if (msg.role === 'camera') {
        const m = msg.matchId ? reg.matches.get(msg.matchId) : reg.byCode(msg.code);
        if (!m) return send({ type: 'error', code: 'no-match', message: 'No match with this code. Check the code on the referee dashboard.' });
        let cam = msg.cameraId && m.cameras.get(msg.cameraId);
        if (cam && cam.token !== msg.cameraToken) cam = null;
        if (cam && msg.resume && cam.conn) cam = null; // device-wide resume must not hijack a camera that is online in another tab
        if (!cam) {
          const ok = (msg.matchId && msg.joinKey === m.joinKey) || (msg.code && String(msg.code) === m.code);
          if (!ok) return send({ type: 'error', code: 'bad-key', message: 'Invalid pairing link or code' });
          cam = { id: 'cam' + (m.nextCam++), token: rid(18), label: String(msg.label || '').slice(0, 40) || null, joined: Date.now(), conn: null };
          cam.label = cam.label || 'Camera ' + cam.id.slice(3); m.cameras.set(cam.id, cam); reg.save(m);
        }
        if (cam.conn) cam.conn({ type: 'error', code: 'replaced', message: 'This camera reconnected from another connection' });
        cam.conn = send; me = { match: m, role: 'camera', cameraId: cam.id };
        send({ type: 'welcome', role: 'camera', matchId: m.id, name: m.name, cameraId: cam.id, cameraToken: cam.token, label: cam.label, hostOnline: !!m.host });
        sendTo(m, 'host', { type: 'camera-online', cameraId: cam.id, label: cam.label });
        log(`camera ${cam.id} connected to ${m.id}`); return;
      }
      return send({ type: 'error', code: 'bad-role' });
    }
    if (!me) return send({ type: 'error', code: 'no-hello' });
    const m = me.match;
    if (msg.type === 'signal') {
      if (me.role === 'camera') sendTo(m, 'host', { type: 'signal', from: me.cameraId, data: msg.data });
      else if (!sendTo(m, msg.to, { type: 'signal', from: 'host', data: msg.data })) send({ type: 'peer-offline', cameraId: msg.to });
      return;
    }
    if (me.role !== 'host') return;
    if (msg.type === 'kick') { const c = m.cameras.get(msg.cameraId); if (c) { c.conn?.({ type: 'kicked' }); m.cameras.delete(msg.cameraId); reg.save(m); send({ type: 'camera-removed', cameraId: msg.cameraId }); } return; }
    if (msg.type === 'rename') { const c = m.cameras.get(msg.cameraId); if (c) { c.label = String(msg.label).slice(0, 40); reg.save(m); } return; }
    if (msg.type === 'rotate-code') { m.code = reg.newCode(); m.joinKey = rid(12); reg.save(m); send({ type: 'code', code: m.code, joinKey: m.joinKey }); return; }
  }
  function onClose() {
    if (!me) return; const m = me.match;
    if (me.role === 'host' && m.host === send) { m.host = null; for (const c of m.cameras.values()) c.conn?.({ type: 'host-offline' }); }
    if (me.role === 'camera') { const c = m.cameras.get(me.cameraId); if (c && c.conn === send) { c.conn = null; sendTo(m, 'host', { type: 'camera-offline', cameraId: c.id }); } }
    log(`${me.role} disconnected from ${m.id}`);
  }
  return { onMessage, onClose, get me() { return me; } };
}
