// Synthetic multi-camera basketball scenario generator (SYNTHETIC ground truth for logic tests).
// Players are 3-D stick figures with scripted feet/hands; cameras are pinhole models; output is in
// the same format the browser detectors produce (bbox, score, MediaPipe-style 33-landmark pose, ball).
import { lookAtCamera, project } from './synth.js';

const BINS = 52;
export function jersey(bin) { const j = new Float32Array(BINS); j[bin] = 0.85; j[(bin + 1) % 48] = 0.15; const s = new Float32Array(BINS); s[bin] = 1; return { jersey: j, shorts: s }; }
export const TEAM_EMB = [jersey(0), jersey(32)];

export function lerp(a, b, k) { return a.map((v, i) => v + (b[i] - v) * k); }
/** Piecewise-linear path through keyframes [[t,[x,y]],...]. */
export function path(keys) { return t => { if (t <= keys[0][0]) return keys[0][1]; for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])); return keys[keys.length - 1][1]; }; }

/**
 * Gait: list of foot contacts [{foot:'L'|'R', t0 (plant), t1 (lift), at:[x,y]}]. Between contacts the foot
 * swings (raised 12 cm) from the previous plant location to the next one.
 */
export function gait(contacts, start = { L: [0, 0], R: [0, 0] }) {
  const by = { L: contacts.filter(c => c.foot === 'L'), R: contacts.filter(c => c.foot === 'R') };
  return (foot, t) => {
    const cs = by[foot]; let prev = { t1: -Infinity, at: start[foot] };
    for (const c of cs) { if (t < c.t0) { const k = Math.max(0, Math.min(1, (t - prev.t1) / (c.t0 - prev.t1))); if (!Number.isFinite(prev.t1)) return [...c.at, 0.0]; return [...lerp(prev.at, c.at, k), 0.25 * Math.sin(Math.PI * k)]; } if (t <= c.t1) return [...c.at, 0]; prev = c; }
    return [...prev.at, 0];
  };
}

export function skeleton({ pos, facing = 0, feet, hands = null, jump = 0, height = 1.95 }) {
  const d = [Math.cos(facing), Math.sin(facing)], n = [-d[1], d[0]], s = height / 1.95;
  const P = (x, y, z) => [x, y, z];
  const at = (c, a, b, z) => P(c[0] + a * d[0] + b * n[0], c[1] + a * d[1] + b * n[1], z * s + jump);
  const L = feet.L, R = feet.R, hipC = [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2];
  const J = new Array(33);
  J[0] = at(pos, 0.1, 0, 1.70); for (let i = 1; i <= 10; i++) J[i] = at(pos, 0.08, (i % 2 ? 0.04 : -0.04), 1.72);
  J[11] = at(pos, 0, 0.2, 1.45); J[12] = at(pos, 0, -0.2, 1.45);
  J[13] = at(pos, 0.05, 0.27, 1.15); J[14] = at(pos, 0.05, -0.27, 1.15);
  J[15] = hands?.L || at(pos, 0.1, 0.27, 0.88); J[16] = hands?.R || at(pos, 0.1, -0.27, 0.88);
  for (const [w, ids] of [[15, [17, 19, 21]], [16, [18, 20, 22]]]) ids.forEach((k, i) => { J[k] = [J[w][0] + 0.04 * d[0], J[w][1] + 0.04 * d[1], J[w][2] - 0.03 * (i + 1) / 3]; });
  J[23] = at(hipC, 0, 0.1, 0.95); J[24] = at(hipC, 0, -0.1, 0.95);
  J[27] = [L[0], L[1], L[2] + 0.08 + jump]; J[28] = [R[0], R[1], R[2] + 0.08 + jump];
  J[25] = lerp(J[23], J[27], 0.5); J[26] = lerp(J[24], J[28], 0.5); J[25][0] += 0.05 * d[0]; J[26][0] += 0.05 * d[0];
  J[29] = [L[0] - 0.08 * d[0], L[1] - 0.08 * d[1], L[2] + 0.03 + jump]; J[30] = [R[0] - 0.08 * d[0], R[1] - 0.08 * d[1], R[2] + 0.03 + jump];
  J[31] = [L[0] + 0.15 * d[0], L[1] + 0.15 * d[1], L[2] + 0.02 + jump]; J[32] = [R[0] + 0.15 * d[0], R[1] + 0.15 * d[1], R[2] + 0.02 + jump];
  return J;
}

export class Scenario {
  constructor({ cameras, width = 1280, height = 720 }) {
    this.cams = cameras.map((c, i) => ({ id: c.id || 'cam' + (i + 1), ...lookAtCamera({ ...c, width, height }) }));
    this.players = []; this.ballFn = () => null; this.hidden = [];
  }
  addPlayer(p) { this.players.push({ team: 0, ...p }); return this; }
  setBall(fn) { this.ballFn = fn; return this; }
  hide(cam, playerId, t0, t1) { this.hidden.push({ cam, playerId, t0, t1 }); return this; }
  /** Returns {cam -> {persons, balls}} with ground-truth ids in .gt */
  frame(t) {
    const out = {};
    for (const cam of this.cams) {
      const persons = [];
      for (const p of this.players) {
        if (this.hidden.some(h => h.cam === cam.id && h.playerId === p.id && t >= h.t0 && t <= h.t1)) continue;
        const st = p.state(t), J = skeleton(st);
        const pose = J.map(X => { const q = project(cam.P, X); return q ? { x: q[0], y: q[1], v: 0.95 } : { x: 0, y: 0, v: 0 }; });
        const xs = pose.filter(q => q.v).map(q => q.x), ys = pose.filter(q => q.v).map(q => q.y);
        const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8, y0 = Math.min(...ys) - 10, y1 = Math.max(...ys) + 3;
        if (x1 < 0 || y1 < 0 || x0 > cam.width || y0 > cam.height) continue;
        persons.push({ bbox: [x0, y0, x1 - x0, y1 - y0], score: 0.9, emb: TEAM_EMB[p.team], pose, gt: p.id });
      }
      const balls = []; const B = this.ballFn(t);
      if (B) { const q = project(cam.P, B), q2 = project(cam.P, [B[0] + 0.12 * cam.R[0][0], B[1] + 0.12 * cam.R[0][1], B[2] + 0.12 * cam.R[0][2]]); if (q && q2) balls.push({ x: q[0], y: q[1], r: Math.hypot(q2[0] - q[0], q2[1] - q[1]), score: 0.8, source: 'model' }); }
      out[cam.id] = { persons, balls };
    }
    return out;
  }
}

/** Run a scenario through a GameAnalyzer. Returns collected events/alerts and per-frame states. */
export function run(analyzer, sc, { t0 = 0, t1 = 5, fps = 30, onTick } = {}) {
  for (const cam of sc.cams) analyzer.setCalibration(cam.id, { Hc2i: cam.H, width: cam.width, height: cam.height });
  const res = { actions: [], alerts: [], states: [], gtMap: [] };
  for (let k = 0; t0 + k / fps <= t1; k++) {
    const t = t0 + k / fps, fr = sc.frame(t);
    for (const [cam, det] of Object.entries(fr)) analyzer.processCameraFrame(cam, t, det);
    const st = analyzer.tick(t);
    res.actions.push(...st.actions); res.alerts.push(...st.alerts);
    // ground-truth -> global id mapping per frame (for ID consistency metrics)
    for (const [cam, det] of Object.entries(fr)) {
      const c = analyzer.cams.get(cam);
      for (const d of det.persons) { const tr = c.tracker.tracks.find(x => x.det && x.det.gt === d.gt && x.lastSeen === t); if (!tr) continue; const g = analyzer.fusion.byCameraTrack(cam, tr.id); if (g) res.gtMap.push({ t, cam, gt: d.gt, gid: g.id }); }
    }
    res.states.push({ t, poss: st.poss, players: st.players.map(p => ({ id: p.id, pos: p.pos, team: p.team })) });
    onTick?.(t, st);
  }
  return res;
}

export const STANDARD_CAMS = [
  { id: 'cam1', eye: [2, -13, 7], target: [7, 0, 0], f: 1000 },
  { id: 'cam2', eye: [17, 9, 6], target: [7, 0, 0], f: 1000 },
];
