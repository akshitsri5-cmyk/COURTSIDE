// Basketball tracking.
//  * BallTracker (per camera, image px): constant-acceleration Kalman filter (parabolic flight in the image),
//    gated association of detector boxes + colour-blob candidates (motion-blurred balls are often missed
//    by generic detectors), coasting through short occlusions, global re-acquisition, vertical-reversal events.
//  * findBallCandidates(): orange/brown blob detector inside a search window (classic CV fallback).
//  * BallFusion: time-synchronised multi-view triangulation (needs >= 2 calibrated cameras) and 3-D
//    ballistic trajectory fit for shot analysis.
import { KF2D } from './kalman.js';
import { triangulate } from './homography.js';

export class BallTracker {
  constructor(opts = {}) {
    this.o = { minDetScore: 0.25, reacquireScore: 0.4, maxCoastSec: 0.6, q: 4e5, r: 16, colourScore: 0.3, ...opts };
    this.kf = null; this.t = 0; this.lastSeen = -1; this.radius = 8; this.state = 'lost';
    this.history = []; // {t, u, v, r, measured, source}
    this.events = [];  // reversal events {type:'reversal', t, u, v}
    this.prevVy = 0; this.coasted = 0;
  }
  /** candidates: [{x,y,r,score,source:'model'|'colour'}]. t seconds. Returns current estimate or null. */
  update(cands, t) {
    const o = this.o;
    if (this.kf) this.kf.predict(t - this.t);
    this.t = t;
    let chosen = null;
    if (this.kf && this.state !== 'lost') {
      const [px, py] = this.kf.pos, sigma = Math.max(this.kf.std, 4);
      const gate = Math.max(4 * this.radius, 4 * sigma);
      let best = Infinity;
      for (const c of cands) {
        if (c.score < (c.source === 'colour' ? o.colourScore : o.minDetScore)) continue;
        const d = Math.hypot(c.x - px, c.y - py); if (d > gate) continue;
        const sizePenalty = Math.abs(Math.log((c.r || this.radius) / this.radius));
        const cost = d / gate + 0.5 * sizePenalty + (c.source === 'colour' ? 0.25 : 0) - 0.3 * c.score;
        if (cost < best) { best = cost; chosen = c; }
      }
    }
    let maneuver = false;
    if (!chosen && this.kf && this.state !== 'lost' && this.lastMeas) {
      // Manoeuvre (bounce off floor/rim/hand = instantaneous velocity change): accept a candidate reachable
      // from the last MEASURED position at a physically plausible speed, then re-initialise the velocity.
      const dt = Math.max(1e-3, t - this.lastMeas.t), [vx, vy] = this.kf.vel, reach = Math.max(4 * this.radius, 1.6 * Math.hypot(vx, vy) * dt + 3 * this.radius);
      let best = Infinity;
      for (const c of cands) {
        if (c.score < (c.source === 'colour' ? o.colourScore : o.minDetScore)) continue;
        const d = Math.hypot(c.x - this.lastMeas.x, c.y - this.lastMeas.y); if (d > reach) continue;
        if (Math.abs(Math.log((c.r || this.radius) / this.radius)) > 0.5) continue;
        if (d < best) { best = d; chosen = c; }
      }
      if (chosen) maneuver = true;
    }
    if (!chosen) { // global (re)acquisition: best model detection anywhere
      const strong = cands.filter(c => c.source !== 'colour' && c.score >= o.reacquireScore).sort((a, b) => b.score - a.score);
      if (strong.length && (this.state === 'lost' || !this.kf)) chosen = strong[0];
    }
    if (chosen) {
      if (!this.kf || this.state === 'lost') { this.kf = new KF2D([chosen.x, chosen.y], { order: 3, q: o.q, r: o.r, p0: 25, pv0: 1e6 }); this.prevVy = 0; }
      else if (maneuver) {
        const dt = Math.max(1e-3, t - this.lastMeas.t), v0 = [(chosen.x - this.lastMeas.x) / dt, (chosen.y - this.lastMeas.y) / dt];
        this.kf = new KF2D([chosen.x, chosen.y], { order: 3, q: o.q, r: o.r, p0: o.r, pv0: 4e4, v0: 0 });
        this.kf.fx.x[1] = v0[0]; this.kf.fy.x[1] = v0[1];
      }
      else this.kf.update([chosen.x, chosen.y], chosen.source === 'colour' ? o.r * 4 : o.r);
      this.radius = 0.7 * this.radius + 0.3 * (chosen.r || this.radius);
      this.lastSeen = t; this.state = 'tracking'; this.coasted = 0; this.lastMeas = { x: chosen.x, y: chosen.y, t };
    } else if (this.kf && this.state !== 'lost') {
      this.coasted = t - this.lastSeen;
      this.state = this.coasted > o.maxCoastSec ? 'lost' : 'occluded';
    }
    if (this.state === 'lost') return null;
    const [u, v] = this.kf.pos, [, vy] = this.kf.vel;
    this.history.push({ t, u, v, r: this.radius, measured: !!chosen, source: chosen?.source || 'predicted', score: chosen?.score ?? null });
    while (this.history.length && t - this.history[0].t > 8) this.history.shift();
    // vertical reversal (image y grows downward): descending -> ascending = bounce (or catch from below).
    // Hysteresis state machine; the event is time-stamped at the lowest MEASURED position (the bounce point).
    if (chosen) {
      const vth = Math.max(20, 2.5 * this.radius);
      if (vy > vth) { if (!this.desc) this.desc = { maxV: -Infinity }; }
      if (this.desc && chosen.y > this.desc.maxV) this.desc = { maxV: chosen.y, t, u: chosen.x, r: chosen.r || this.radius };
      if (this.desc && vy < -vth * 0.6 && Number.isFinite(this.desc.maxV)) { this.events.push({ type: 'reversal', t: this.desc.t, u: this.desc.u, v: this.desc.maxV, r: this.desc.r, detectedAt: t }); this.desc = null; }
    } else if (this.state === 'occluded' && this.coasted > 0.25) this.desc = null;
    while (this.events.length > 50) this.events.shift();
    return this.estimate();
  }
  estimate() {
    if (!this.kf || this.state === 'lost') return null;
    const [u, v] = this.kf.pos, [vu, vv] = this.kf.vel;
    return { u, v, vu, vv, r: this.radius, state: this.state, t: this.t, sigma: this.kf.std, measured: this.lastSeen === this.t };
  }
  /** Interpolated measured position at time t (for cross-camera synchronisation). */
  at(t, maxGap = 0.08) {
    const H = this.history.filter(h => h.measured); if (H.length < 1) return null;
    let a = null, b = null; for (const h of H) { if (h.t <= t) a = h; else { b = h; break; } }
    if (a && b && b.t - a.t < 0.25) { const k = (t - a.t) / (b.t - a.t); return { u: a.u + k * (b.u - a.u), v: a.v + k * (b.v - a.v), r: a.r }; }
    const n = a && Math.abs(a.t - t) <= maxGap ? a : b && Math.abs(b.t - t) <= maxGap ? b : null;
    return n ? { u: n.u, v: n.v, r: n.r } : null;
  }
}

/**
 * Colour-based ball candidates (orange/brown leather) within an optional search window.
 * img: {width,height,data}. Returns [{x,y,r,score,source:'colour'}]. Uses a coarse grid + connected components.
 */
export function findBallCandidates(img, { window = null, step = 2, minR = 3, maxR = 60, hueLo = 5, hueHi = 35, minSat = 0.45, minVal = 0.25 } = {}) {
  const W = img.width, H = img.height;
  const [x0, y0, x1, y1] = window ? [Math.max(0, window[0] | 0), Math.max(0, window[1] | 0), Math.min(W, window[2] | 0), Math.min(H, window[3] | 0)] : [0, 0, W, H];
  const gw = Math.ceil((x1 - x0) / step), gh = Math.ceil((y1 - y0) / step); if (gw <= 0 || gh <= 0) return [];
  const m = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = x0 + gx * step, y = y0 + gy * step, i = (y * W + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d || mx !== r) continue;
    const h = ((g - b) / d) * 60, s = d / mx, v = mx / 255;
    if (h >= hueLo && h <= hueHi && s >= minSat && v >= minVal) m[gy * gw + gx] = 1;
  }
  const out = [], lab = new Int32Array(gw * gh), stack = [];
  let L = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue; L++; stack.push(i); lab[i] = L;
    let n = 0, sx = 0, sy = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    while (stack.length) {
      const k = stack.pop(), kx = k % gw, ky = (k / gw) | 0; n++; sx += kx; sy += ky;
      minx = Math.min(minx, kx); maxx = Math.max(maxx, kx); miny = Math.min(miny, ky); maxy = Math.max(maxy, ky);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = kx + dx, ny = ky + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const j = ny * gw + nx; if (m[j] && !lab[j]) { lab[j] = L; stack.push(j); } }
    }
    const bw = (maxx - minx + 1) * step, bh = (maxy - miny + 1) * step, r = (bw + bh) / 4;
    if (r < minR || r > maxR) continue;
    const aspect = Math.max(bw, bh) / Math.min(bw, bh), fill = n * step * step / (Math.PI * r * r);
    // a ball is round (motion blur stretches it up to ~2.5:1) and fills its disc
    if (aspect > 2.5 || fill < 0.35) continue;
    const score = Math.max(0, Math.min(1, (1 - (aspect - 1) / 2.5) * Math.min(1, fill) * 0.9));
    out.push({ x: x0 + (sx / n) * step + step / 2, y: y0 + (sy / n) * step + step / 2, r, score, source: 'colour' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Multi-view ball fusion + 3-D trajectory. cameras: Map cam -> {P (3x4)} for calibrated cameras. */
export class BallFusion {
  constructor() { this.points = []; } // {t, X:[x,y,z], err, cams}
  /** trackers: Map cam -> BallTracker. Returns latest 3-D point or null. */
  update(t, trackers, cameras, { maxReprojErr = 20 } = {}) {
    const views = [];
    for (const [cam, tr] of trackers) { const c = cameras.get(cam); if (!c?.P) continue; const p = tr.at(t); if (p) views.push({ cam, P: c.P, pt: [p.u, p.v] }); }
    if (views.length < 2) return null;
    let res; try { res = triangulate(views); } catch { return null; }
    if (res.reprojError > maxReprojErr || res.X[2] < -0.5 || res.X[2] > 12) return null;
    const pt = { t, X: res.X, err: res.reprojError, cams: views.map(v => v.cam) };
    this.points.push(pt); while (this.points.length && t - this.points[0].t > 6) this.points.shift();
    return pt;
  }
  latest(maxAge = 0.2, now) { const p = this.points[this.points.length - 1]; return p && (now === undefined || now - p.t <= maxAge) ? p : null; }
}

/**
 * Fit a ballistic trajectory X(t) = X0 + V t + 0.5 g t^2 (g = [0,0,-9.81]) to 3-D points by least squares.
 * Returns {X0, V, t0, rms, predict(t)} or null. Needs >= 4 points.
 */
export function fitBallistic(points, g = 9.81) {
  if (points.length < 4) return null;
  const t0 = points[0].t; const n = points.length;
  const fitAxis = (k, grav) => {
    let st = 0, stt = 0, sy = 0, sty = 0;
    for (const p of points) { const t = p.t - t0, y = p.X[k] + (grav ? 0.5 * g * t * t : 0); st += t; stt += t * t; sy += y; sty += t * y; }
    const den = n * stt - st * st; if (Math.abs(den) < 1e-12) return null;
    const v = (n * sty - st * sy) / den, x0 = (sy - v * st) / n; return [x0, v];
  };
  const ax = fitAxis(0, false), ay = fitAxis(1, false), az = fitAxis(2, true); if (!ax || !ay || !az) return null;
  const X0 = [ax[0], ay[0], az[0]], V = [ax[1], ay[1], az[1]];
  const predict = t => { const d = t - t0; return [X0[0] + V[0] * d, X0[1] + V[1] * d, X0[2] + V[2] * d - 0.5 * g * d * d]; };
  const rms = Math.sqrt(points.reduce((s, p) => { const q = predict(p.t); return s + (q[0] - p.X[0]) ** 2 + (q[1] - p.X[1]) ** 2 + (q[2] - p.X[2]) ** 2; }, 0) / n);
  return { X0, V, t0, rms, predict };
}

/** Image-space quadratic fit per axis (single-camera trajectory estimate). Returns predict(t) or null. */
export function fitImageParabola(hist) {
  const pts = hist.filter(h => h.measured); if (pts.length < 4) return null;
  const t0 = pts[0].t;
  const fit = key => { // least squares a + b t + c t^2
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], R = [0, 0, 0];
    for (const p of pts) { const t = p.t - t0, row = [1, t, t * t]; for (let i = 0; i < 3; i++) { R[i] += row[i] * p[key]; for (let j = 0; j < 3; j++) S[i][j] += row[i] * row[j]; } }
    try { return solve3(S, R); } catch { return null; }
  };
  const cu = fit('u'), cv = fit('v'); if (!cu || !cv) return null;
  return { predict: t => { const d = t - t0; return [cu[0] + cu[1] * d + cu[2] * d * d, cv[0] + cv[1] * d + cv[2] * d * d]; }, cu, cv, t0 };
}
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular'); [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; } }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
