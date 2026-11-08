// Multi-camera fusion on the court plane. Each calibrated camera contributes observations of its local
// tracks (foot point -> court metres via that camera's homography). Global player identities are kept
// with sticky camera-track bindings, Kalman filtering in metres, appearance-based cross-camera
// re-identification and time-synchronised association (observations are predicted to the fusion time).
import { KF2D } from './kalman.js';
import { hungarian } from './hungarian.js';
import { applyH, hDepth } from './homography.js';
import { appearanceDistance, blendEmbedding, clusterTeams } from './appearance.js';

/** Map an image point to court metres with a 1-sigma uncertainty (m) from a pixel sigma. */
export function imageToCourt(Hi2c, [u, v], pixSigma = 3) {
  if (hDepth(Hi2c, [u, v]) === 0) return null;
  const p = applyH(Hi2c, [u, v]), px = applyH(Hi2c, [u + 1, v]), py = applyH(Hi2c, [u, v + 1]);
  if (![...p, ...px, ...py].every(Number.isFinite)) return null;
  const mpp = Math.max(Math.hypot(px[0] - p[0], px[1] - p[1]), Math.hypot(py[0] - p[0], py[1] - p[1]));
  return { p, sigma: Math.max(0.05, mpp * pixSigma) };
}

let GNEXT = 1;
export class GlobalTrack {
  constructor(obs, t) {
    this.id = 'P' + (GNEXT++); this.kf = new KF2D(obs.court, { q: 6, r: obs.sigma ** 2, p0: obs.sigma ** 2, pv0: 4 });
    this.t = t; this.lastSeen = t; this.created = t; this.bindings = new Map(); this.emb = obs.emb || null; this.hits = 1;
    this.team = null; this.teamVotes = [0, 0]; this.isReferee = false; this.history = []; this.lastObs = new Map();
    this.label = null; // human-assigned jersey number/name
  }
  predict(t) { const dt = t - this.t; if (dt > 0) { this.kf.predict(dt); this.t = t; } }
  get pos() { return this.kf.pos; } get vel() { return this.kf.vel; }
  get speed() { const [vx, vy] = this.kf.vel; return Math.hypot(vx, vy); }
  pushHistory(t) { this.history.push({ t, p: this.pos.slice(), v: this.vel.slice() }); while (this.history.length && t - this.history[0].t > 6) this.history.shift(); }
  /** Position/velocity at an earlier time (nearest history sample). */
  at(t) { let best = null; for (const h of this.history) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h; return best; }
}

export class MultiCameraFusion {
  constructor(opts = {}) {
    this.o = { gate: 1.4, lostGateSpeed: 7, reidMaxApp: 0.35, maxLostSec: 20, courtMargin: 2.0, bindBreakDist: 2.2, appearanceWeight: 0.35, ...opts };
    this.globals = []; this.cameraTrackMap = new Map(); // "cam:track" -> global
  }
  /**
   * observations: [{cam, track, t, court:[x,y], sigma, emb, vel?:[vx,vy] m/s}] already in metres.
   * Each observation is extrapolated to fusion time `t` with its own velocity (time synchronisation).
   */
  update(observations, t, model) {
    const o = this.o;
    const obs = observations.filter(ob => !model || model.insideMargin(ob.court) > -o.courtMargin).map(ob => {
      const dt = t - ob.t, v = ob.vel || [0, 0];
      return { ...ob, at: [ob.court[0] + v[0] * dt, ob.court[1] + v[1] * dt], sigma: ob.sigma + Math.abs(dt) * 1.0 };
    });
    for (const g of this.globals) g.predict(t);
    const assigned = new Map(); // global -> [obs]
    const add = (g, ob) => { (assigned.get(g) || assigned.set(g, []).get(g)).push(ob); g.bindings.set(ob.cam, ob.track); this.cameraTrackMap.set(ob.cam + ':' + ob.track, g); };
    const unbound = [];
    // 1. sticky bindings (identity follows the camera tracker unless physically inconsistent)
    for (const ob of obs) {
      const g = this.cameraTrackMap.get(ob.cam + ':' + ob.track);
      if (g && this.globals.includes(g) && Math.hypot(g.pos[0] - ob.at[0], g.pos[1] - ob.at[1]) < o.bindBreakDist + 2 * ob.sigma && !(assigned.get(g) || []).some(x => x.cam === ob.cam)) add(g, ob);
      else { if (g) this.cameraTrackMap.delete(ob.cam + ':' + ob.track); unbound.push(ob); }
    }
    // 2. per-camera Hungarian association of unbound observations to globals not yet fed by that camera
    const cams = [...new Set(unbound.map(ob => ob.cam))];
    const leftovers = [];
    for (const cam of cams) {
      const cobs = unbound.filter(ob => ob.cam === cam);
      const cands = this.globals.filter(g => !(assigned.get(g) || []).some(x => x.cam === cam) && !(g.bindings.get(cam) && this.isLiveBinding(g, cam, observations)));
      const cost = cobs.map(ob => cands.map(g => this.cost(g, ob, t)));
      const a = hungarian(cost, 1.0);
      cobs.forEach((ob, i) => { if (a[i] >= 0) add(cands[a[i]], ob); else leftovers.push(ob); });
    }
    // 3. new globals: cluster leftover observations from different cameras that coincide on court
    const used = new Set();
    for (let i = 0; i < leftovers.length; i++) {
      if (used.has(i)) continue; const grp = [leftovers[i]]; used.add(i);
      for (let j = i + 1; j < leftovers.length; j++) {
        if (used.has(j) || grp.some(x => x.cam === leftovers[j].cam)) continue;
        const d = Math.hypot(leftovers[i].at[0] - leftovers[j].at[0], leftovers[i].at[1] - leftovers[j].at[1]);
        if (d < 0.9 + leftovers[i].sigma + leftovers[j].sigma && appearanceDistance(leftovers[i].emb, leftovers[j].emb) < 0.45) { grp.push(leftovers[j]); used.add(j); }
      }
      const g = new GlobalTrack({ court: grp[0].at, sigma: grp[0].sigma, emb: grp[0].emb }, t); this.globals.push(g); grp.forEach(ob => add(g, ob));
    }
    // 4. measurement update: inverse-variance weighted mean of all cameras observing the player
    for (const [g, list] of assigned) {
      let wx = 0, wy = 0, ws = 0; for (const ob of list) { const w = 1 / (ob.sigma ** 2); wx += w * ob.at[0]; wy += w * ob.at[1]; ws += w; }
      g.kf.update([wx / ws, wy / ws], 1 / ws); g.lastSeen = t; g.hits++;
      for (const ob of list) { if (ob.emb) g.emb = blendEmbedding(g.emb, ob.emb, 0.08); g.lastObs.set(ob.cam, ob); }
      g.cameras = list.map(ob => ob.cam);
    }
    for (const g of this.globals) { if (!assigned.has(g)) g.cameras = []; g.pushHistory(t); }
    // drop long-lost globals
    this.globals = this.globals.filter(g => t - g.lastSeen <= o.maxLostSec);
    for (const [k, g] of this.cameraTrackMap) if (!this.globals.includes(g)) this.cameraTrackMap.delete(k);
    return this.globals;
  }
  isLiveBinding(g, cam, observations) { const tr = g.bindings.get(cam); return observations.some(ob => ob.cam === cam && ob.track === tr); }
  cost(g, ob, t) {
    const o = this.o, dt = t - g.lastSeen, d = Math.hypot(g.pos[0] - ob.at[0], g.pos[1] - ob.at[1]);
    const app = appearanceDistance(g.emb, ob.emb), hasApp = !!(g.emb && ob.emb);
    if (dt < 0.6) { // active global
      const gate = o.gate + 2 * ob.sigma; if (d > gate) return 1e6;
      return (1 - o.appearanceWeight) * d / gate + o.appearanceWeight * app;
    }
    // lost global: re-identify within physically reachable distance, appearance must agree
    const gate = Math.min(14, o.gate + o.lostGateSpeed * dt) + 2 * ob.sigma;
    if (d > gate || (hasApp && app > o.reidMaxApp)) return 1e6;
    return 0.3 + 0.35 * d / gate + 0.35 * (hasApp ? app / o.reidMaxApp : 0.8);
  }
  active(t, maxAge = 0.6) { return this.globals.filter(g => t - g.lastSeen <= maxAge && g.hits >= 2); }
  byCameraTrack(cam, track) { return this.cameraTrackMap.get(cam + ':' + track) || null; }
  /** Re-cluster teams from jersey colours; votes accumulate so labels are stable over time. */
  updateTeams() {
    const players = this.globals.filter(g => !g.isReferee && g.emb && g.hits > 5);
    const r = clusterTeams(players.map(g => g.emb)); if (!r.labels || r.separation < 0.25) return r;
    // keep cluster label orientation consistent with previous majority
    let agree = 0, disagree = 0; players.forEach((g, i) => { if (g.team === null) return; if (g.team === r.labels[i]) agree++; else disagree++; });
    const flip = disagree > agree;
    players.forEach((g, i) => { const l = flip ? 1 - r.labels[i] : r.labels[i]; g.teamVotes[l]++; g.team = g.teamVotes[0] >= g.teamVotes[1] ? 0 : 1; });
    return r;
  }
}
