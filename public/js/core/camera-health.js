// Camera health: frame-rate / freeze monitoring, obstruction, camera movement and court visibility.
// Works on small grayscale thumbnails (e.g. 96x54) so it can run on every analysed frame.

export function thumbStats(g, w, h) {
  let s = 0, s2 = 0, edges = 0;
  for (let i = 0; i < g.length; i++) { s += g[i]; s2 += g[i] * g[i]; }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]) > 40) edges++; }
  const n = g.length, mean = s / n; return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), edgeDensity: edges / ((w - 2) * (h - 2)) };
}
function gradMag(g, w, h) { const o = new Float32Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; o[i] = Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]); } return o; }

/** Global translation between reference and current thumbnails by SAD block matching on gradients. */
export function estimateShift(ref, cur, w, h, maxShift = 6) {
  const A = gradMag(ref, w, h), B = gradMag(cur, w, h); let best = { dx: 0, dy: 0, sad: Infinity }, zero = 0;
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    let sad = 0, n = 0;
    for (let y = maxShift + 1; y < h - maxShift - 1; y += 1) for (let x = maxShift + 1; x < w - maxShift - 1; x += 1) { sad += Math.abs(A[y * w + x] - B[(y + dy) * w + x + dx]); n++; }
    sad /= n; if (dx === 0 && dy === 0) zero = sad; if (sad < best.sad) best = { dx, dy, sad };
  }
  return { ...best, zeroSad: zero, gain: zero > 0 ? 1 - best.sad / zero : 0 };
}

export class CameraHealthMonitor {
  constructor(opts = {}) {
    this.o = { freezeSec: 2, minFps: 8, moveThreshPx: 2, obstructStdRatio: 0.35, obstructEdgeRatio: 0.3, courtFitDrop: 0.6, ...opts };
    this.frames = []; this.lastFrameT = null; this.ref = null; this.refStats = null; this.state = {}; this.motionSpikes = []; this.courtFit = null; this.refCourtFit = null; this.network = {};
  }
  /** Reference = thumbnail at calibration time. */
  setReference(g, w, h) { this.ref = { g: Float32Array.from(g), w, h }; this.refStats = thumbStats(g, w, h); this.shift = { dx: 0, dy: 0 }; }
  noteFrame(t) { this.frames.push(t); while (this.frames.length && t - this.frames[0] > 3) this.frames.shift(); this.lastFrameT = t; }
  noteDeviceMotion(t, magnitude) { if (magnitude > 1.5) this.motionSpikes.push(t); while (this.motionSpikes.length && t - this.motionSpikes[0] > 10) this.motionSpikes.shift(); }
  noteCourtFit(fraction, isReference = false) { if (isReference) this.refCourtFit = fraction; this.courtFit = fraction; }
  noteNetwork(s) { this.network = { ...this.network, ...s }; }
  /** Analyse a thumbnail; returns health report. */
  check(t, g = null, w = 0, h = 0) {
    const o = this.o, issues = [];
    const fps = this.frames.length > 1 ? (this.frames.length - 1) / (this.frames[this.frames.length - 1] - this.frames[0]) : 0;
    const frozen = this.lastFrameT !== null && t - this.lastFrameT > o.freezeSec;
    if (frozen) issues.push({ code: 'frozen', msg: `No new frames for ${(t - this.lastFrameT).toFixed(1)} s` });
    else if (this.frames.length > 5 && fps < o.minFps) issues.push({ code: 'low_fps', msg: `Low frame rate (${fps.toFixed(1)} fps)` });
    let stats = null;
    if (g) {
      stats = thumbStats(g, w, h);
      if (this.refStats) {
        if (stats.std < this.refStats.std * o.obstructStdRatio || stats.edgeDensity < this.refStats.edgeDensity * o.obstructEdgeRatio || stats.mean < 15)
          issues.push({ code: 'obstructed', msg: 'View obstructed or covered (texture/contrast collapsed vs calibration)' });
        if (this.ref && this.ref.w === w && this.ref.h === h) {
          const s = estimateShift(this.ref.g, g, w, h); this.shift = s;
          if (Math.hypot(s.dx, s.dy) >= o.moveThreshPx && s.gain > 0.15) issues.push({ code: 'moved', msg: `Camera moved ≈${Math.hypot(s.dx, s.dy).toFixed(0)} px (thumbnail) since calibration — recalibrate` });
        }
      } else if (stats.mean < 15 || stats.std < 6) issues.push({ code: 'obstructed', msg: 'Very dark or uniform image' });
    }
    if (this.motionSpikes.length && t - this.motionSpikes[this.motionSpikes.length - 1] < 5) issues.push({ code: 'bumped', msg: 'Phone accelerometer detected a bump' });
    if (this.refCourtFit && this.courtFit !== null && this.courtFit < this.refCourtFit * o.courtFitDrop) issues.push({ code: 'court_lost', msg: `Court lines visibility dropped to ${Math.round(this.courtFit * 100)} % (was ${Math.round(this.refCourtFit * 100)} %)` });
    if (this.network.packetLossPct > 5) issues.push({ code: 'packet_loss', msg: `Packet loss ${this.network.packetLossPct.toFixed(1)} %` });
    const level = issues.some(i => ['frozen', 'obstructed', 'moved', 'court_lost'].includes(i.code)) ? 'bad' : issues.length ? 'warn' : 'ok';
    this.state = { t, fps, frozen, issues, level, stats, shift: this.shift, network: this.network };
    return this.state;
  }
}
