// WebSocket signalling client with automatic reconnection (exponential backoff) and clock sync.
import { ClockSync } from '../core/camera-sync.js';
export class SignalClient {
  constructor(helloFn) { this.helloFn = helloFn; this.handlers = new Map(); this.clock = new ClockSync(); this.backoff = 500; this.closed = false; this.connected = false; this.connect(); }
  on(type, fn) { (this.handlers.get(type) || this.handlers.set(type, []).get(type)).push(fn); }
  emit(type, m) { for (const f of this.handlers.get(type) || []) f(m); }
  connect() {
    const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { this.connected = true; this.backoff = 500; this.send(this.helloFn()); this.syncBurst(); this.emit('open'); };
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'time') { this.clock.addSample(m.t0, m.ts, performance.now() + performance.timeOrigin); return; } this.emit(m.type, m); this.emit('*', m); };
    ws.onclose = () => { this.connected = false; this.emit('close'); if (!this.closed) { setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(8000, this.backoff * 2); } };
    ws.onerror = () => { };
  }
  send(m) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  syncBurst(n = 8) { let i = 0; const tick = () => { if (i++ >= n || this.ws.readyState !== 1) return; this.send({ type: 'time', t0: performance.now() + performance.timeOrigin }); setTimeout(tick, 150); }; tick(); clearInterval(this.syncIv); this.syncIv = setInterval(() => this.send({ type: 'time', t0: performance.now() + performance.timeOrigin }), 10000); }
  /** Server time (ms since epoch) for a local performance.now() value. */
  serverTime(perfMs = performance.now()) { return perfMs + performance.timeOrigin + this.clock.offset; }
  close() { this.closed = true; this.ws?.close(); clearInterval(this.syncIv); }
}
