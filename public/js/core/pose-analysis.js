// Pose-based body analysis from 2-D keypoints (MediaPipe BlazePose 33-landmark layout, image px).
// FootContactAnalyzer turns a keypoint stream into discrete foot events: plant / lift / jump / land.
// Static cameras are assumed (camera movement is detected separately by CameraHealth).
import { applyH } from './homography.js';

export const LM = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16, L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20, L_THUMB: 21, R_THUMB: 22, L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28, L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32 };
export const HAND_POINTS = { L: [15, 17, 19, 21], R: [16, 18, 20, 22] };
export const LIMB_SEGMENTS = [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [15, 19], [16, 20]];
export const TORSO = [11, 12, 24, 23];

const vis = (p, thr = 0.5) => p && (p.v ?? 1) >= thr;
export function mid(a, b) { return [(a.x + b.x) / 2, (a.y + b.y) / 2]; }

/** Body height in px from pose (shoulder-to-ankle * 1.2) or bbox fallback. */
export function bodyHeight(pose, bbox) {
  if (pose && vis(pose[11]) && vis(pose[12]) && (vis(pose[27]) || vis(pose[28]))) {
    const sh = mid(pose[11], pose[12]), ank = vis(pose[27]) && vis(pose[28]) ? mid(pose[27], pose[28]) : vis(pose[27]) ? [pose[27].x, pose[27].y] : [pose[28].x, pose[28].y];
    const h = Math.hypot(sh[0] - ank[0], sh[1] - ank[1]) * 1.25; if (h > 10) return h;
  }
  return bbox ? bbox[3] : 100;
}

export function footPoint(pose, side) {
  const ids = side === 'L' ? [27, 29, 31] : [28, 30, 32];
  const pts = ids.map(i => pose?.[i]).filter(p => vis(p));
  if (!pts.length) return null;
  return { p: [pts.reduce((s, q) => s + q.x, 0) / pts.length, Math.max(...pts.map(q => q.y))], q: pts.reduce((s, q) => s + (q.v ?? 1), 0) / ids.length };
}

/** Distance from point to segment. */
export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function segSegDist(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}
function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
export function pointInPolygon([x, y], poly) {
  let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins;
}

/** Minimum hand-to-ball distance in body heights (negative => overlapping the ball). */
export function handBallDistance(pose, ball, Hb) {
  let best = Infinity, side = null, below = null;
  for (const s of ['L', 'R']) for (const i of HAND_POINTS[s]) {
    const p = pose?.[i]; if (!vis(p, 0.4)) continue;
    const d = (Math.hypot(p.x - ball.u, p.y - ball.v) - ball.r) / Hb;
    if (d < best) { best = d; side = s; below = (p.y - ball.v) / Math.max(ball.r, 1); }
  }
  return { d: best, side, below };
}

export class FootContactAnalyzer {
  constructor(opts = {}) {
    this.o = { plantSpeed: 0.45, liftSpeed: 0.9, liftElev: 0.05, jumpElev: 0.08, hipRise: 0.3, minAirSec: 0.2, minVis: 0.5, ...opts };
    this.feet = { L: this.newFoot(), R: this.newFoot() }; this.prevT = null; this.airborne = false; this.prevHip = null; this.events = [];
    this.hipBase = null;
  }
  newFoot() { return { state: 'unknown', pos: null, ground: null, slowCount: 0, plantT: null, liftT: null, court: null, q: 0 }; }
  /** Returns new events since last call. Hi2c (image->court) optional, used for court positions of plants. */
  update(t, pose, bbox, Hi2c = null) {
    const out = [], o = this.o, Hb = bodyHeight(pose, bbox), dt = this.prevT === null ? null : t - this.prevT;
    this.prevT = t;
    if (!pose) return out;
    for (const side of ['L', 'R']) {
      const f = this.feet[side], fp = footPoint(pose, side);
      if (!fp || fp.q < o.minVis) { f.q = fp?.q || 0; continue; }
      f.q = fp.q;
      if (f.pos && dt && dt > 0 && dt < 0.5) {
        const speed = Math.hypot(fp.p[0] - f.pos[0], fp.p[1] - f.pos[1]) / dt / Hb;
        const elev = f.ground ? (f.ground[1] - fp.p[1]) / Hb : 0;
        if (f.state !== 'grounded') {
          // A planted foot is stationary in a static camera. Image elevation is unreliable under perspective when the
          // foot moved horizontally, but for a (near-)vertical lift (jump) a foot hanging above its take-off point
          // at the apex is NOT a plant.
          const vertical = f.liftPos && Math.abs(fp.p[0] - f.liftPos[0]) < 0.15 * Hb;
          const aboveTakeoff = vertical && (f.liftPos[1] - fp.p[1]) / Hb > 0.04;
          if (speed < o.plantSpeed && !aboveTakeoff) {
            const wasUnknown = f.state === 'unknown';
            if (++f.slowCount >= 2 || wasUnknown) {
              f.state = 'grounded'; f.plantT = wasUnknown ? t : t - dt; // contact began at the first slow sample
              f.ground = fp.p.slice(); f.court = Hi2c ? applyH(Hi2c, fp.p) : null;
              out.push({ type: 'plant', foot: side, t: f.plantT, img: fp.p.slice(), court: f.court, q: fp.q, initial: wasUnknown || f.liftT === null });
            }
          }
          else f.slowCount = 0;
        } else if (speed > o.liftSpeed || (elev > o.liftElev && speed > o.plantSpeed)) {
          f.state = 'lifted'; f.liftT = t - dt / 2; f.liftPos = f.ground ? f.ground.slice() : fp.p.slice(); f.slowCount = 0; out.push({ type: 'lift', foot: side, t: f.liftT, q: fp.q });
        }
        if (f.state === 'lifted') f.elev = elev; else f.elev = 0;
      } else if (!f.pos) { f.state = 'unknown'; }
      f.pos = fp.p.slice();
    }
    // Jump / landing: both feet off the floor and raised (or hip rising fast), then first ground contact.
    const L = this.feet.L, R = this.feet.R;
    const hip = vis(pose[23]) && vis(pose[24]) ? mid(pose[23], pose[24]) : null;
    let hipVy = 0; if (hip && this.prevHip && dt) hipVy = (hip[1] - this.prevHip[1]) / dt / Hb; this.prevHip = hip;
    // A running stride also has a (short, ~0.1 s) flight phase; a JUMP keeps both feet off the floor longer.
    const bothUp = L.state === 'lifted' && R.state === 'lifted';
    if (bothUp && this.bothUpSince === undefined) this.bothUpSince = Math.max(L.liftT, R.liftT);
    if (!bothUp) this.bothUpSince = undefined;
    if (!this.airborne && bothUp && t - this.bothUpSince >= o.minAirSec) {
      this.airborne = true; this.jumpT = this.bothUpSince; out.push({ type: 'jump', t: this.jumpT, q: Math.min(L.q, R.q) });
    } else if (this.airborne && (L.state === 'grounded' || R.state === 'grounded')) {
      this.airborne = false; const both = L.state === 'grounded' && R.state === 'grounded';
      out.push({ type: 'land', t: Math.min(...[L, R].filter(f => f.state === 'grounded').map(f => f.plantT)), feet: both ? 'both' : (L.state === 'grounded' ? 'L' : 'R'), q: Math.min(L.q, R.q) });
    }
    this.events.push(...out); while (this.events.length > 200) this.events.shift();
    return out;
  }
  groundedFeet() { return ['L', 'R'].filter(s => this.feet[s].state === 'grounded'); }
  quality() { return (this.feet.L.q + this.feet.R.q) / 2; }
}

/** Arm extension: max wrist distance from torso centre, in body heights. */
export function armExtension(pose, Hb) {
  if (!pose || !vis(pose[11]) || !vis(pose[12]) || !vis(pose[23]) || !vis(pose[24])) return null;
  const c = [(pose[11].x + pose[12].x + pose[23].x + pose[24].x) / 4, (pose[11].y + pose[12].y + pose[23].y + pose[24].y) / 4];
  let m = 0; for (const i of [15, 16]) if (vis(pose[i])) m = Math.max(m, Math.hypot(pose[i].x - c[0], pose[i].y - c[1]) / Hb);
  return m;
}
/** True if either wrist is above the shoulders (shooting / rebounding arm position). */
export function handsAboveShoulders(pose) {
  if (!pose || !vis(pose[11]) || !vis(pose[12])) return false;
  const sy = Math.min(pose[11].y, pose[12].y);
  return [15, 16].some(i => vis(pose[i]) && pose[i].y < sy);
}
