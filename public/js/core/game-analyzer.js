// GameAnalyzer: orchestrates the per-camera and fused analysis pipeline.
//   processCameraFrame(cam, t, detections)  -> per-camera tracking (players + ball) [called per analysed frame]
//   tick(t)                                 -> fusion, pose events, possession, actions, rules, fouls [called ~10-15 Hz]
// All times are seconds on the common (server-synchronised) match clock.
import { CourtModel } from './court-model.js';
import { invertH, cameraFromHomography, projectP } from './homography.js';
import { PlayerTracker } from './player-tracking.js';
import { MultiCameraFusion, imageToCourt } from './multicam-fusion.js';
import { BallTracker, BallFusion } from './ball-tracking.js';
import { FootContactAnalyzer, bodyHeight } from './pose-analysis.js';
import { PossessionEstimator } from './possession.js';
import { ActionRecognizer } from './action-recognition.js';
import { RuleEngine } from './rule-engine.js';
import { FoulDetector } from './foul-detection.js';
import { AppearanceLinker } from './appearance-linker.js';

/** Associate pose skeletons with person detections (keypoint containment), returns dets with .pose. */
export function attachPoses(dets, poses) {
  const used = new Set();
  const scored = [];
  dets.forEach((d, i) => poses.forEach((p, j) => {
    const [x, y, w, h] = d.bbox; let inside = 0, n = 0;
    for (const k of [0, 11, 12, 23, 24, 25, 26, 27, 28]) { const q = p[k]; if (!q || (q.v ?? 1) < 0.5) continue; n++; if (q.x >= x - 0.1 * w && q.x <= x + 1.1 * w && q.y >= y - 0.1 * h && q.y <= y + 1.1 * h) inside++; }
    if (n >= 4 && inside / n > 0.7) scored.push({ i, j, s: inside / n + n / 100 });
  }));
  scored.sort((a, b) => b.s - a.s); const out = dets.map(d => ({ ...d, pose: null })), di = new Set();
  for (const { i, j } of scored) { if (di.has(i) || used.has(j)) continue; out[i].pose = poses[j]; di.add(i); used.add(j); }
  return out;
}

export class GameAnalyzer {
  constructor({ ruleset, model = new CourtModel(ruleset.court), clock = null } = {}) {
    this.cfg = ruleset; this.model = model; this.clock = clock;
    this.cams = new Map();       // cam -> {tracker, ball, calib:{Hc2i,Hi2c,P,width,height,rims,mpp}, lastT}
    this.fusion = new MultiCameraFusion();
    this.ballFusion = new BallFusion();
    this.feet = new Map();        // `${pid}@${cam}` -> FootContactAnalyzer
    this.possession = new PossessionEstimator(ruleset.analysis);
    this.actions = new ActionRecognizer({ cfg: ruleset.analysis, scoring: ruleset.scoring, model, getTakeoff: (p, t) => this.getTakeoff(p, t), isClockRunning: () => this.clock ? this.clock.running : true });
    this.rules = new RuleEngine({ cfg: ruleset, model });
    this.fouls = new FoulDetector({ cfg: ruleset, model });
    this.reversalCursor = new Map(); this.lastTick = null; this.tickTimes = []; this.lastTeamUpdate = 0; this.prevPossTeam = null;
    this.lastState = null; this.trackerOpts = {};
    this.linker = new AppearanceLinker({ maxIds: ruleset.oneOnOne ? 2 : 8 }); // uncalibrated cross-camera identity
  }
  camera(cam) {
    if (!this.cams.has(cam)) this.cams.set(cam, { tracker: new PlayerTracker({ idPrefix: cam + '-', ...this.trackerOpts }), ball: new BallTracker(), calib: null, lastT: null, enabled: true });
    return this.cams.get(cam);
  }
  /** Detector-specific score thresholds (COCO-SSD scores people lower than YOLO). Applies to existing cameras too. */
  setTrackerOptions(o) { this.trackerOpts = { ...this.trackerOpts, ...o }; for (const c of this.cams.values()) Object.assign(c.tracker.o, o); }
  removeCamera(cam) { this.cams.delete(cam); }
  /**
   * Calibration: Hc2i = court(m)->image(px) homography for an image of width x height.
   * rimsManual: optional [{side, u, v, rx, ry}] clicked by the operator (preferred over the model projection).
   */
  setCalibration(cam, { Hc2i, width, height, rimsManual = null }) {
    const c = this.camera(cam);
    if (!Hc2i) { c.calib = null; return null; }
    const Hi2c = invertH(Hc2i), camModel = cameraFromHomography(Hc2i, width, height);
    let rims = rimsManual || [];
    if (!rimsManual && camModel.reliable) {
      rims = [-1, 1].map(side => {
        const r3 = this.model.rim3D(side), rr = this.model.d.rimRadius, c0 = projectP(camModel.P, r3);
        if (!c0 || c0[0] < -50 || c0[1] < -50 || c0[0] > width + 50 || c0[1] > height + 50) return null;
        const px = projectP(camModel.P, [r3[0] + rr, r3[1], r3[2]]), py = projectP(camModel.P, [r3[0], r3[1] + rr, r3[2]]);
        const rx = Math.max(Math.abs(px[0] - c0[0]), Math.abs(py[0] - c0[0]), 2), ry = Math.max(Math.abs(px[1] - c0[1]), Math.abs(py[1] - c0[1]), 1);
        return { side, u: c0[0], v: c0[1], rx, ry, source: 'model' };
      }).filter(Boolean);
    }
    const centre = imageToCourt(Hi2c, [width / 2, height * 0.75], 1);
    c.calib = { Hc2i, Hi2c, P: camModel.reliable ? camModel.P : null, camModel, width, height, rims, mpp: centre ? centre.sigma : 0.05 };
    return c.calib;
  }

  /** detections: {persons:[{bbox,score,emb?,pose?}], balls:[{x,y,r,score,source}]} in image px. */
  processCameraFrame(cam, t, det) {
    const c = this.camera(cam); if (!c.enabled) return null;
    const tracks = c.tracker.update(det.persons || [], t);
    this.linker.update(cam, tracks);
    const ball = c.ball.update(det.balls || [], t);
    c.lastT = t;
    return { tracks, ball };
  }

  /** Take-off position for shot classification: court positions of the last foot plants before t. */
  getTakeoff(pid, t) {
    const evs = (this.rules.foot.get(pid) || []).filter(e => e.type === 'plant' && e.court && e.t <= t + 0.05 && e.primary !== false);
    const last = evs.slice(-2); if (!last.length) return null;
    const pos = [last.reduce((s, e) => s + e.court[0], 0) / last.length, last.reduce((s, e) => s + e.court[1], 0) / last.length];
    const sigma = Math.max(0.08, ...last.map(e => e.sigma || 0.15));
    return { pos, sigma };
  }

  tick(t) {
    const fps = this.lastTick ? 1 / Math.max(1e-3, t - this.lastTick) : 0; this.lastTick = t;
    this.tickTimes.push(t); while (this.tickTimes.length > 30) this.tickTimes.shift();
    // ---- 1. multi-camera fusion of player tracks on the court plane ----
    const obs = [];
    for (const [cam, c] of this.cams) {
      if (!c.calib || !c.enabled) continue;
      for (const tr of c.tracker.active()) {
        if (t - tr.lastSeen > 0.3) continue;
        const m = imageToCourt(c.calib.Hi2c, tr.foot, Math.max(2, 0.03 * tr.bbox[3])); if (!m) continue;
        const ahead = imageToCourt(c.calib.Hi2c, [tr.foot[0] + tr.velocity[0] * 0.1, tr.foot[1] + tr.velocity[1] * 0.1], 1);
        const vel = ahead ? [(ahead.p[0] - m.p[0]) / 0.1, (ahead.p[1] - m.p[1]) / 0.1] : [0, 0];
        obs.push({ cam, track: tr.id, t: tr.lastSeen, court: m.p, sigma: m.sigma, emb: tr.emb, vel: vel.map(v => Math.max(-9, Math.min(9, v))) });
      }
    }
    const globals = this.fusion.update(obs, t, this.model);
    if (this.cfg.oneOnOne) this.assignOneOnOneSides(t);
    else if (t - this.lastTeamUpdate > 2) { this.fusion.updateTeams(); this.lastTeamUpdate = t; }
    const active = this.fusion.active(t);

    // ---- 2. per-player views + foot events (primary camera = best foot visibility) ----
    const players = [], footEvents = [];
    for (const g of active) {
      const views = {}; let primary = null, bestQ = -1; const fevByCam = {};
      for (const [cam, trId] of g.bindings) {
        const c = this.cams.get(cam); if (!c) continue; const tr = c.tracker.tracks.find(x => x.id === trId);
        if (!tr || t - tr.lastSeen > 0.25) continue;
        const pose = tr.poseT === tr.lastSeen ? tr.pose : null;
        views[cam] = { bbox: tr.bbox, pose, trackId: tr.id };
        const key = g.id + '@' + cam; const fa = this.feet.get(key) || this.feet.set(key, new FootContactAnalyzer()).get(key);
        if (pose && fa.lastPoseT !== tr.lastSeen) { fa.lastPoseT = tr.lastSeen; fevByCam[cam] = fa.update(tr.lastSeen, pose, tr.bbox, c.calib?.Hi2c || null); }
        if (fa.quality() > bestQ) { bestQ = fa.quality(); primary = cam; }
      }
      for (const [cam, evs] of Object.entries(fevByCam)) for (const e of evs) footEvents.push({ ...e, player: g.id, cam, primary: cam === primary, speed: g.speed, sigma: this.cams.get(cam)?.calib?.mpp ? this.cams.get(cam).calib.mpp * 3 : 0.15 });
      const pfa = primary ? this.feet.get(g.id + '@' + primary) : null;
      players.push({ id: g.id, label: g.label, team: g.team, isReferee: g.isReferee, pos: g.pos.slice(), vel: g.vel.slice(), speed: g.speed, views, primaryCam: primary, airborne: !!pfa?.airborne, groundedFeet: pfa ? pfa.groundedFeet().length : null, history: tt => g.at(tt), cameras: g.cameras });
    }
    this.rules.addFootEvents(footEvents);

    // ---- 3. ball: per-camera estimates, reversal events, multi-view triangulation ----
    const ball = { views: {}, X: null, reversals: [] };
    const trackers = new Map(), calibs = new Map();
    for (const [cam, c] of this.cams) {
      const est = c.ball.estimate(); if (est && t - est.t < 0.3) ball.views[cam] = est;
      trackers.set(cam, c.ball); if (c.calib?.P) calibs.set(cam, { P: c.calib.P });
      const cur = this.reversalCursor.get(cam) || 0; const evs = c.ball.events.filter(e => e.t > cur);
      for (const e of evs) ball.reversals.push({ ...e, cam }); if (evs.length) this.reversalCursor.set(cam, evs[evs.length - 1].t);
    }
    const p3 = this.ballFusion.update(t, trackers, calibs);
    ball.at3 = tt => { let b = null; for (const q of this.ballFusion.points) if (Math.abs(q.t - tt) < 0.06 && (!b || Math.abs(q.t - tt) < Math.abs(b.t - tt))) b = q; return b ? b.X : null; };
    if (p3) { ball.X = p3.X; const pts = this.ballFusion.points; if (pts.length > 1) { const a = pts[pts.length - 2]; ball.vz = (p3.X[2] - a.X[2]) / Math.max(1e-3, p3.t - a.t); } }
    ball.points3 = this.ballFusion.points;
    // de-duplicate the same physical bounce seen by several cameras, also across ticks (keep earliest)
    this.recentRev = (this.recentRev || []).filter(x => t - x < 3);
    ball.reversals.sort((a, b) => a.t - b.t);
    ball.reversals = ball.reversals.filter(r => { if (this.recentRev.some(x => Math.abs(x - r.t) < 0.15)) return false; this.recentRev.push(r.t); return true; });

    // ---- 4. possession, actions, rules, fouls ----
    const poss = this.possession.update(t, players, ball);
    const camsInfo = new Map([...this.cams].map(([cam, c]) => [cam, { Hi2c: c.calib?.Hi2c, rims: c.calib?.rims || [], mpp: c.calib?.mpp }]));
    const actions = this.actions.update(t, poss, players, ball, camsInfo);
    for (const a of actions) this.fouls.noteAction(a);
    const ruleAlerts = this.rules.update(t, actions, poss, players, { fps: this.analysisFps(), possConfidence: poss.confidence });
    const foulAlerts = this.fouls.update(t, players, poss, { fps: this.cameraFps() });
    if (this.clock && poss.changed && poss.team !== null && poss.team !== undefined) {
      const reb = actions.find(a => a.type === 'rebound');
      this.clock.onPossessionChange(poss.team, this.prevPossTeam, { offensiveReboundAfterRim: !!(reb && reb.offensive) });
      this.prevPossTeam = poss.team;
    }
    this.lastState = { t, players, ball, poss, actions, alerts: [...ruleAlerts, ...foulAlerts], footEvents, globals: globals.length, info: this.rules.info.splice(0) };
    return this.lastState;
  }
  /**
   * 1v1: each player is their own side. Clothing may be identical, so sides follow player identity:
   * the first player tracked becomes side 0 (Player A), the other side 1. A re-identified player keeps the
   * side; a new ID (player lost too long) takes whichever side is not currently on court.
   */
  assignOneOnOneSides(t) {
    const act = this.fusion.active(t).filter(g => !g.isReferee).sort((a, b) => a.created - b.created).slice(0, 2);
    for (const g of act) {
      if (g.team === 0 || g.team === 1) continue;
      const other = act.find(o => o !== g && (o.team === 0 || o.team === 1));
      g.team = other ? 1 - other.team : (this.lastSideSeen?.[0] && !this.lastSideSeen?.[1] ? 1 : 0);
    }
    this.lastSideSeen = { 0: act.some(g => g.team === 0), 1: act.some(g => g.team === 1) };
  }
  /** Per-camera analysed frame rate (detections per second), the rate that limits temporal rules. */
  cameraFps() { let best = 0; for (const c of this.cams.values()) { const h = c.tracker.tracks.find(t => t.history.length > 3)?.history; if (h) { const n = h.length; best = Math.max(best, (n - 1) / Math.max(1e-3, h[n - 1].t - h[0].t)); } } return best || 10; }
  analysisFps() { const T = this.tickTimes; return T.length > 2 ? (T.length - 1) / (T[T.length - 1] - T[0]) : 0; }
}
