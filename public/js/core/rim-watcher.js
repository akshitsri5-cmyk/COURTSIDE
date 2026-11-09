// Score agent: watches a small box around the rim at the camera's FULL frame rate (cheap frame differencing,
// no neural network, no court calibration). A made basket = motion arriving ABOVE the rim, followed within
// ~0.8 s by motion IN THE NET that clearly exceeds motion BESIDE the net (a ball bouncing off the rim moves the
// side regions instead). Input: grayscale samples of four regions per frame (see regions()).

/** Regions (image px) for a rim at (u,v) with half-width rx: above, net, left, right. */
export function regions({ u, v, rx }) {
  const w = 2 * rx, nh = 2.2 * rx;
  return { above: [u - rx, v - 2 * rx, w, 1.6 * rx], net: [u - rx * 0.8, v + 0.3 * rx, 1.6 * rx, nh], left: [u - 3 * rx, v + 0.3 * rx, 1.6 * rx, nh], right: [u + 1.4 * rx, v + 0.3 * rx, 1.6 * rx, nh] };
}

export class RimWatcher {
  constructor(opts = {}) { this.o = { window: 0.8, minRatio: 2.2, k: 4, refractory: 2.5, ...opts }; this.prev = null; this.noise = { above: [], net: [], left: [], right: [] }; this.aboveT = null; this.lastEventT = -1e9; this.events = []; }
  /** samples: {above, net, left, right} -> Float32Array grayscale of each region (same sizes every frame). */
  update(t, samples) {
    const o = this.o; let ev = null;
    if (this.prev) {
      // motion = mean of the most-changed quarter of the box: sensitive to a small ball, not just big movements
      const m = {}; for (const k of Object.keys(samples)) { const a = samples[k], b = this.prev[k], d = new Float32Array(a.length); for (let i = 0; i < a.length; i++) d[i] = Math.abs(a[i] - b[i]); d.sort(); const q = Math.max(1, d.length >> 2); let s = 0; for (let i = d.length - q; i < d.length; i++) s += d[i]; m[k] = s / q; }
      const base = k => { const n = this.noise[k]; if (!n.length) return 2; const srt = [...n].sort((x, y) => x - y); return Math.max(1.5, srt[srt.length >> 1]); };
      const hot = k => m[k] > o.k * base(k) + 6;
      if (hot('above')) this.aboveT = t;
      if (this.aboveT !== null && t - this.aboveT <= o.window && hot('net') && t - this.lastEventT > o.refractory) {
        const side = Math.max(m.left, m.right, 1), ratio = m.net / side;
        if (ratio >= o.minRatio) { ev = { type: 'basket', t, ratio, confidence: Math.min(0.95, 0.6 + 0.08 * (ratio - o.minRatio)), netMotion: m.net, sideMotion: side }; this.lastEventT = t; this.aboveT = null; this.events.push(ev); }
      }
      if (this.aboveT !== null && t - this.aboveT > o.window) this.aboveT = null;
      for (const k of Object.keys(m)) if (!hot(k)) { this.noise[k].push(m[k]); if (this.noise[k].length > 60) this.noise[k].shift(); } // learn the background noise level
    }
    this.prev = samples; return ev;
  }
}

/** Combine single-camera basket events: two cameras within 0.7 s = one high-confidence basket. */
export function fuseBaskets(events, t, win = 0.7) {
  const open = events.filter(e => !e.used && t - e.t <= 3 * win); if (!open.length) return null;
  const first = open.reduce((a, b) => (a.t <= b.t ? a : b)), group = open.filter(e => e.t - first.t <= win);
  const cams = new Set(group.map(e => e.cam));
  if (cams.size >= 2) { group.forEach(e => e.used = true); return { t: first.t, cams: [...cams], confidence: 0.95 }; }
  if (t - first.t >= win) { group.forEach(e => e.used = true); return { t: first.t, cams: [first.cam], confidence: first.confidence }; } // no 2nd camera came
  return null; // wait briefly for a second camera
}
