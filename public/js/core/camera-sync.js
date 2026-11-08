// Camera synchronisation.
//  * ClockSync: NTP/Cristian-style offset estimation between a device clock and the server clock
//    (keeps the samples with the lowest round-trip time, which have the least asymmetric delay).
//  * FrameTimestamper: converts WebRTC frame metadata (requestVideoFrameCallback captureTime /
//    receiveTime) into a common match clock, compensating per-camera network+jitter-buffer latency.
//  * FlashSync: optional verification/correction — a light flash (or clap-board) seen by all cameras
//    produces a brightness step; its per-camera detection time gives the residual offset of each feed.

export class ClockSync {
  constructor({ keep = 8 } = {}) { this.samples = []; this.keep = keep; }
  /** t0 = local send time, ts = server time, t1 = local receive time (all ms). */
  addSample(t0, ts, t1) {
    const rtt = t1 - t0; if (!(rtt >= 0)) return;
    this.samples.push({ rtt, offset: ts - (t0 + t1) / 2, at: t1 });
    this.samples.sort((a, b) => a.rtt - b.rtt); if (this.samples.length > 32) this.samples.length = 32;
  }
  get ready() { return this.samples.length >= 3; }
  /** Offset to add to local time to obtain server time (ms). Median of the lowest-RTT samples. */
  get offset() { const s = this.samples.slice(0, this.keep).map(x => x.offset).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }
  get uncertainty() { const b = this.samples[0]; return b ? b.rtt / 2 : Infinity; }
  toServer(localMs) { return localMs + this.offset; }
}

export class FrameTimestamper {
  /**
   * localToServer: fn(localMs) -> serverMs for the dashboard clock.
   * stats: {rttMs, jitterBufferMs} per camera, refreshed from RTCPeerConnection.getStats().
   */
  constructor(localToServer) { this.l2s = localToServer; this.stats = new Map(); this.correction = new Map(); }
  setStats(cam, s) { this.stats.set(cam, { ...(this.stats.get(cam) || {}), ...s }); }
  setCorrection(cam, ms) { this.correction.set(cam, ms); }
  /** meta: rVFC metadata {captureTime?, receiveTime?, expectedDisplayTime?}; nowMs: dashboard performance.now(). */
  stamp(cam, meta = {}, nowMs) {
    let local, method;
    if (Number.isFinite(meta.captureTime) && meta.captureTime > 0) { local = meta.captureTime; method = 'captureTime'; }
    else {
      const s = this.stats.get(cam) || {}; const base = Number.isFinite(meta.receiveTime) ? meta.receiveTime : (Number.isFinite(meta.expectedDisplayTime) ? meta.expectedDisplayTime : nowMs);
      local = base - (s.rttMs ? s.rttMs / 2 : 0) - (Number.isFinite(meta.receiveTime) ? 0 : (s.jitterBufferMs || 0)); method = Number.isFinite(meta.receiveTime) ? 'receiveTime-rtt/2' : 'display-latency';
    }
    return { serverMs: this.l2s(local) - (this.correction.get(cam) || 0), method };
  }
}

/** Detect the first strong brightness step in a luminance series [{t, y}] (ms, 0-255). Returns t or null. */
export function detectFlash(series, { minJump = 35, baselineN = 5 } = {}) {
  for (let i = baselineN; i < series.length; i++) {
    const base = series.slice(i - baselineN, i).reduce((s, x) => s + x.y, 0) / baselineN;
    if (series[i].y - base >= minJump) {
      // sub-frame interpolation between previous and current sample
      const prev = series[i - 1], half = base + (series[i].y - base) / 2;
      const k = (half - prev.y) / ((series[i].y - prev.y) || 1); return prev.t + Math.max(0, Math.min(1, k)) * (series[i].t - prev.t);
    }
  }
  return null;
}
/** Per-camera corrections (ms) relative to the reference camera from flash detection times. */
export function flashOffsets(flashTimes, refCam) {
  const ref = flashTimes[refCam]; if (ref === null || ref === undefined) return null;
  const out = {}; for (const [cam, t] of Object.entries(flashTimes)) if (t !== null && t !== undefined) out[cam] = t - ref; return out;
}
