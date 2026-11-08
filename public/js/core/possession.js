// Possession estimation. A player is "in contact" with the ball when a hand landmark touches the ball
// in a camera view, no other calibrated view clearly contradicts it (depth ambiguity), and — when a
// triangulated 3-D ball exists — the ball is physically near the player. Control persists through a
// dribble while the ball stays in the player's control zone. Hysteresis prevents flicker.
import { handBallDistance, bodyHeight } from './pose-analysis.js';

/**
 * players: [{id, team, pos:[x,y], views:{cam:{bbox, pose}}}]
 * ball: {views:{cam:{u,v,r,vu,vv,measured}}, X:[x,y,z]|null}
 */
export function contactEvidence(player, ball, cfg) {
  const per = []; let contra = 0;
  for (const [cam, view] of Object.entries(player.views || {})) {
    const b = ball.views?.[cam]; if (!b || !view?.bbox) continue;
    const Hb = bodyHeight(view.pose, view.bbox);
    let d, side = null, below = null, viaPose = false;
    if (view.pose) { const r = handBallDistance(view.pose, b, Hb); if (Number.isFinite(r.d)) { d = r.d; side = r.side; below = r.below; viaPose = true; } }
    if (d === undefined) { // no usable pose: weak box-based fallback (upper body region)
      const [x, y, w, h] = view.bbox, inUpper = b.u > x - b.r && b.u < x + w + b.r && b.v > y && b.v < y + 0.65 * h;
      d = inUpper ? cfg.possessionContactDist * 0.9 : Math.max(0, Math.min(Math.abs(b.u - (x + w / 2)) - w / 2, 1e9)) / Hb + 0.2;
    }
    const inZone = (() => { const [x, y, w, h] = view.bbox; return Math.abs(b.u - (x + w / 2)) < 0.6 * w + 0.4 * h * 0.25 && b.v > y + 0.25 * h && b.v < y + h * 1.08; })();
    per.push({ cam, d, side, below, viaPose, inZone, measured: b.measured, Hb });
    if (b.measured && d > 0.5 && viaPose) contra++;
  }
  if (!per.length) return null;
  const best = per.reduce((a, b) => (a.d <= b.d ? a : b));
  let far3D = false;
  if (ball.X && player.pos && ball.X[2] < 3.2) far3D = Math.hypot(ball.X[0] - player.pos[0], ball.X[1] - player.pos[1]) > 1.2;
  const contact = best.d < cfg.possessionContactDist && contra === 0 && !far3D;
  return { contact, d: best.d, side: best.side, below: best.below, viaPose: best.viaPose, cams: per.filter(p => p.d < cfg.possessionContactDist).map(p => p.cam), viewCount: per.length, inZone: per.some(p => p.inZone) && !far3D, per };
}

export class PossessionEstimator {
  constructor(cfg) {
    this.cfg = cfg; this.controller = null; this.team = null; this.state = 'loose'; this.since = 0;
    this.candidate = null; this.candCount = 0; this.lastContactT = -Infinity; this.outOfZoneSince = null; this.lastController = null; this.lastControllerTeam = null;
    this.contact = null; this.confidence = 0;
  }
  update(t, players, ball) {
    const cfg = this.cfg, prevController = this.controller, prevState = this.state;
    const ballSeen = ball && Object.values(ball.views || {}).some(v => v);
    let best = null;
    if (ballSeen) for (const p of players) {
      if (p.isReferee) continue;
      const ev = contactEvidence(p, ball, cfg); if (!ev) continue; ev.player = p;
      if (ev.contact && (!best || ev.d < best.d)) best = ev;
    }
    this.contact = best;
    if (best) {
      if (this.candidate === best.player.id) this.candCount++; else { this.candidate = best.player.id; this.candCount = 1; }
      if (best.player.id === this.controller) { this.lastContactT = t; this.outOfZoneSince = null; }
      else if (this.candCount >= cfg.possessionMinFrames) {
        if (this.controller) { this.lastController = this.controller; this.lastControllerTeam = this.team; this.releaseT = this.lastContactT; } // direct hand-off / steal
        this.controller = best.player.id; this.team = best.player.team ?? null; this.since = t; this.lastContactT = t; this.outOfZoneSince = null;
      }
    } else { this.candidate = null; this.candCount = 0; }

    if (this.controller) {
      const cp = players.find(p => p.id === this.controller);
      const ev = cp && ballSeen ? contactEvidence(cp, ball, cfg) : null;
      const touching = best && best.player.id === this.controller;
      if (touching) this.state = 'holding';
      else if (ev && ev.inZone) { this.state = 'dribbling'; this.outOfZoneSince = null; }
      else {
        if (this.outOfZoneSince === null) this.outOfZoneSince = t;
        if (t - this.outOfZoneSince >= cfg.controlLossSec || !cp) {
          this.lastController = this.controller; this.lastControllerTeam = this.team; this.releaseT = this.lastContactT;
          this.controller = null; this.team = null;
        }
      }
    }
    if (!this.controller) {
      const speed = ball ? Math.max(0, ...Object.values(ball.views || {}).filter(Boolean).map(v => Math.hypot(v.vu || 0, v.vv || 0) / Math.max(v.r * 8, 1))) : 0;
      this.state = speed > 2 ? 'in_flight' : 'loose';
    }
    // confidence: views agreeing on contact / total views of that player, pose-based contact preferred
    this.confidence = this.controller ? Math.min(1, 0.5 + 0.25 * (this.contact?.cams?.length || 0) + (this.contact?.viaPose ? 0.15 : 0)) : 0;
    return { controller: this.controller, team: this.team, state: this.state, changed: prevController !== this.controller, prevController, prevState, lastContactT: this.lastContactT, releaseT: this.releaseT, contact: this.contact, confidence: this.confidence, lastController: this.lastController, lastControllerTeam: this.lastControllerTeam };
  }
}
