// Temporal action recognition for basketball from possession, ball kinematics and pose.
// Rule-based temporal state machines (transparent and testable). A learned skeleton/ball sequence
// classifier can be plugged in through `learnedModel` (see README: requires labelled training data);
// its outputs are merged as additional evidence, never as unexplained decisions.
import { handsAboveShoulders, bodyHeight } from './pose-analysis.js';
import { applyH } from './homography.js';
import { fitBallistic } from './ball-tracking.js';

let SHOT_ID = 1;

export class ActionRecognizer {
  /** ctx: {model, cfg, getTakeoff(pid,t) -> {pos, sigma}|null, isClockRunning() } */
  constructor(ctx) {
    this.ctx = ctx; this.cfg = ctx.cfg; this.model = ctx.model;
    this.phase = null;         // per current controller: {player, mode:'holding'|'dribbling', since, dribbles, dribbleEnded, contactStart, contactFrames, belowFrames, upFrames}
    this.pendingRelease = null; // {player, team, t, kind}
    this.shots = [];           // pending shots awaiting outcome
    this.events = [];
    this.lastShot = null;
    this.learnedModel = ctx.learnedModel || null;
  }
  emit(e) { this.events.push(e); return e; }

  /**
   * poss: PossessionEstimator output, players: [{id, team, pos, views}], ball: {views, X, reversals:[{cam,t,u,v,r}]},
   * cams: Map cam -> {Hi2c, rims:[{side,u,v,rx,ry}]}
   */
  update(t, poss, players, ball, cams) {
    const out = []; const E = e => { out.push(this.emit(e)); };
    const pl = id => players.find(p => p.id === id);
    this.snaps = (this.snaps || []).filter(x => t - x.t < 2); this.snaps.push({ t, ball: { views: ball.views }, poses: Object.fromEntries(players.map(p => [p.id, p.views])) });
    this.points3 = ball.points3 || [];

    // ---- control lost: release classification ----
    if (poss.changed && poss.prevController) {
      const pid = poss.prevController, p = pl(pid), team = p?.team ?? poss.lastControllerTeam ?? null;
      const tRel = poss.releaseT ?? t;
      const shot = this.looksLikeShot(pid, tRel, p, cams);
      if (shot.isShot) {
        const take = this.ctx.getTakeoff?.(pid, tRel) || (p ? { pos: p.pos, sigma: 0.3 } : null);
        const side = shot.side ?? (take ? this.model.sideOf(take.pos) : 1);
        let points = 2, pointsUncertain = true, margin = null, freeThrow = false;
        if (take) {
          margin = this.model.threePointMargin(take.pos, side);
          const sig = Math.max(this.cfg.threePointUncertaintyMin, take.sigma || 0);
          points = margin > 0 ? 3 : 2; pointsUncertain = Math.abs(margin) < sig;
          const ftSpot = [side * (this.model.ftX - 0.3), 0];
          if (this.ctx.isClockRunning && !this.ctx.isClockRunning() && Math.hypot(take.pos[0] - ftSpot[0], take.pos[1]) < 0.8) { points = 1; freeThrow = true; pointsUncertain = false; }
        }
        const s = { type: 'shot', id: 'S' + (SHOT_ID++), t: tRel, player: pid, team, side, points, pointsUncertain, margin, freeThrow, takeoff: take?.pos || null, reasons: shot.reasons };
        E(s); this.shots.push({ ...s, votes: {}, state: {}, deadline: tRel + 3.0, crossed3D: null }); this.lastShot = s;
        this.pendingRelease = { player: pid, team, t: tRel, kind: 'shot', shotId: s.id };
      } else this.pendingRelease = { player: pid, team, t: tRel, kind: 'release' };
      this.phase = null;
    }

    // ---- control gained ----
    if (poss.changed && poss.controller) {
      const p = pl(poss.controller), team = p?.team ?? null;
      const prev = this.pendingRelease;
      if (prev && prev.kind === 'shot') {
        const offensive = prev.team !== null && team !== null ? prev.team === team : null;
        E({ type: 'rebound', t, player: poss.controller, team, offensive, shotId: prev.shotId });
      } else if (prev && prev.player !== poss.controller) {
        if (prev.team !== null && team !== null && prev.team !== team) E({ type: 'turnover', t, from: prev.player, to: poss.controller, team, kind: 'interception' });
        else E({ type: 'pass', t: prev.t, tCatch: t, from: prev.player, to: poss.controller, team });
        E({ type: 'catch', t, player: poss.controller, team, from: prev.player });
      } else if (prev && prev.player === poss.controller) {
        E({ type: 'recover', t, player: poss.controller, team, note: 'same player regained a loose ball (fumble or tip to self)' });
      }
      const fromDribble = false;
      this.phase = { player: poss.controller, team, mode: 'holding', since: t, dribbles: 0, dribbleEnded: false, contactStart: t, contactFrames: 0, belowFrames: 0, upFrames: 0, lastBounceT: null, recovered: !!(prev && prev.player === poss.controller) };
      E({ type: 'gather', t, player: poss.controller, team, kind: prev ? 'catch' : 'pickup', fromDribble });
      this.pendingRelease = null;
    }

    // ---- while in control ----
    const ph = this.phase;
    if (ph && poss.controller === ph.player) {
      const p = pl(ph.player);
      const touching = poss.state === 'holding';
      // floor bounces near the controller => dribble
      for (const rv of ball.reversals || []) {
        if (!this.isFloorBounce(rv, p, ball)) continue;
        if (ph.mode === 'holding') {
          const releaseT = this.lastContactBefore ?? rv.t - 0.1;
          E({ type: 'dribble_start', t: Math.min(releaseT, rv.t), player: ph.player, team: ph.team, afterDribbleEnded: ph.dribbleEnded, continuousControl: !ph.recovered, possConf: ph.possConf });
          ph.mode = 'dribbling';
          if (ph.carryCandidate) ph.carryCandidate = null;
        } else if (ph.carryCandidate) {
          E({ type: 'carry_suspect', t: ph.carryCandidate.t, tEnd: ph.carryCandidate.tEnd, player: ph.player, team: ph.team, evidence: ph.carryCandidate });
          ph.carryCandidate = null;
        }
        ph.dribbles++; ph.lastBounceT = rv.t;
        E({ type: 'bounce', t: rv.t, player: ph.player, cam: rv.cam, n: ph.dribbles });
      }
      // contact episodes during a dribble: gather (dribble end) or carry evidence
      if (touching) {
        ph.possConf = Math.max(ph.possConf || 0, poss.confidence || 0);
        if (ph.contactStart === null) { ph.contactStart = t; ph.contactFrames = 0; ph.belowFrames = 0; ph.upFrames = 0; }
        ph.contactFrames++;
        const c = poss.contact; if (c && c.below !== null && c.below > this.cfg.carryHandBelow) ph.belowFrames++;
        const bv = c && ball.views?.[c.cams?.[0]]; if (bv && bv.vv < -20) ph.upFrames++;
        this.lastContactBefore = t;
        const twoHands = c && this.bothHandsOnBall(p, ball);
        if (ph.mode === 'dribbling' && (t - ph.contactStart >= this.cfg.gatherHoldSec || twoHands)) {
          E({ type: 'gather', t: ph.contactStart, player: ph.player, team: ph.team, kind: 'dribble_end', fromDribble: true, twoHands: !!twoHands, dribbles: ph.dribbles });
          ph.mode = 'holding'; ph.dribbleEnded = true;
        }
      } else if (ph.contactStart !== null) {
        const dur = t - ph.contactStart;
        if (ph.mode === 'dribbling' && dur >= this.cfg.carryMinContactSec && ph.contactFrames && ph.belowFrames / ph.contactFrames > 0.6 && ph.upFrames / ph.contactFrames > 0.4)
          ph.carryCandidate = { t: ph.contactStart, tEnd: t, duration: dur, handBelowFraction: ph.belowFrames / ph.contactFrames, upwardFraction: ph.upFrames / ph.contactFrames };
        ph.contactStart = null;
      }
    }

    // ---- loose-ball floor bounces (for ball out-of-bounds) ----
    if (!poss.controller) for (const rv of ball.reversals || []) {
      const cam = cams.get(rv.cam); let court = null, sigma = 0.3;
      const X = ball.at3?.(rv.t); if (X && X[2] < 0.6) { court = [X[0], X[1]]; sigma = 0.15; }
      else if (cam?.Hi2c) { court = applyH(cam.Hi2c, [rv.u, rv.v + rv.r]); sigma = cam.mpp ? cam.mpp * (rv.r + 3) : 0.4; }
      if (court) E({ type: 'ball_bounce', t: rv.t, court, sigma, cam: rv.cam });
    }

    // ---- shot outcome ----
    for (const s of [...this.shots]) {
      this.trackShot(s, t, ball, cams);
      if ((s.crossed3D !== null || Object.keys(s.votes).length) && s.decidedAt === undefined) s.decidedAt = t;
      const done = t > s.deadline || (s.decidedAt !== undefined && t - s.decidedAt > 0.4) || (poss.controller && t - s.t > 0.8 && s.anyNearRim);
      if (done) { this.shots.splice(this.shots.indexOf(s), 1); E(this.finaliseShot(s, t)); }
    }
    if (this.learnedModel) { try { for (const e of this.learnedModel.update?.(t, poss, players, ball) || []) E({ ...e, source: 'learned-model' }); } catch (err) { /* model errors must never break the pipeline */ } }
    return out;
  }

  isFloorBounce(rv, p, ball) {
    const X = ball.at3?.(rv.t); if (X) return X[2] < 0.45;
    const v = p?.views?.[rv.cam]; if (!v?.bbox) return true; // no player view: assume floor if ball reversed downward->upward
    const [, y, , h] = v.bbox, Hb = bodyHeight(v.pose, v.bbox);
    return rv.v + rv.r >= y + h - 0.15 * Hb; // ball bottom near the player's foot level
  }
  bothHandsOnBall(p, ball) {
    for (const [cam, v] of Object.entries(p?.views || {})) {
      const b = ball.views?.[cam]; if (!b || !v.pose) continue; const Hb = bodyHeight(v.pose, v.bbox);
      const near = i => v.pose[i] && (v.pose[i].v ?? 1) > 0.5 && (Math.hypot(v.pose[i].x - b.u, v.pose[i].y - b.v) - b.r) / Hb < this.cfg.possessionContactDist;
      if (near(15) && near(16)) return true;
    }
    return false;
  }
  /** Evaluate shot features at the RELEASE time (from the snapshot history), not when loss of control is detected. */
  looksLikeShot(pid, tRel, p, cams) {
    const reasons = []; let up = false, strongUp = false, hands = false, toward = false, toward2D = false, side = null;
    const snaps = this.snaps.filter(x => x.t >= tRel - 0.15 && x.t <= tRel + 0.35);
    for (const sn of snaps) for (const [cam, b] of Object.entries(sn.ball.views || {})) {
      if (!b) continue; const v = sn.poses[pid]?.[cam]; const Hb = v ? bodyHeight(v.pose, v.bbox) : b.r * 16;
      if (sn.t >= tRel && -b.vv / Hb > this.cfg.shotMinUpwardSpeed) up = true;
      if (sn.t >= tRel && -b.vv / Hb > 2 * this.cfg.shotMinUpwardSpeed) strongUp = true;
      if (v?.pose && handsAboveShoulders(v.pose) && Math.abs(sn.t - tRel) < 0.2) hands = true;
      for (const rim of cams.get(cam)?.rims || []) {
        const du = rim.u - b.u, dv = rim.v - b.v, n1 = Math.hypot(du, dv), n2 = Math.hypot(b.vu, b.vv);
        if (sn.t >= tRel && n1 > 0 && n2 > 0 && (du * b.vu + dv * b.vv) / (n1 * n2) > 0.85 && dv < 0) { toward2D = true; side = side ?? rim.side; }
      }
    }
    // 3-D: ballistic fit of the triangulated ball after release passing near a rim
    const pts = this.points3.filter(q => q.t >= tRel && q.t <= tRel + 0.6);
    const fit = fitBallistic(pts);
    const has3D = !!(fit && fit.rms < 0.3);
    if (has3D) {
      if (fit.V[2] > 2) up = true;
      for (const sd of [-1, 1]) { const rim = this.model.rim3D(sd); let best = Infinity; for (let dt = 0; dt < 2.5; dt += 0.02) { const q = fit.predict(tRel + dt); if (q[2] < 0) break; best = Math.min(best, Math.hypot(q[0] - rim[0], q[1] - rim[1], q[2] - rim[2])); } if (best < 1.2) { toward = true; side = sd; reasons.push(`3-D ballistic fit passes ${best.toFixed(2)} m from the ${sd > 0 ? 'right' : 'left'} rim`); } }
    }
    if (up) reasons.unshift('ball leaves the hand moving upward');
    if (hands) reasons.push('shooting arm above shoulder at release');
    // With a 3-D trajectory only the 3-D test counts; single-view direction is weaker and needs a strong upward release.
    if (!has3D && toward2D && strongUp) { toward = true; reasons.push('ball moves toward the rim in the image (single view)'); }
    return { isShot: up && (hands || toward), reasons, side };
  }
  trackShot(s, t, ball, cams) {
    if (ball.X) { // 3-D crossing of the rim plane
      const rim = this.model.rim3D(s.side), prev = s.prevX;
      if (prev && prev[2] >= rim[2] && ball.X[2] < rim[2]) {
        const k = (prev[2] - rim[2]) / (prev[2] - ball.X[2]), x = prev[0] + k * (ball.X[0] - prev[0]), y = prev[1] + k * (ball.X[1] - prev[1]);
        s.crossed3D = Math.hypot(x - rim[0], y - rim[1]);
      }
      if (Math.hypot(ball.X[0] - rim[0], ball.X[1] - rim[1]) < 1.5 && Math.abs(ball.X[2] - rim[2]) < 1) s.anyNearRim = true;
      s.prevX = ball.X.slice();
    }
    for (const [cam, b] of Object.entries(ball.views || {})) {
      if (!b || !b.measured) continue;
      const rim = (cams.get(cam)?.rims || []).find(r => r.side === s.side); if (!rim) continue;
      const st = s.state[cam] || (s.state[cam] = { above: false, prev: null });
      const near = Math.abs(b.u - rim.u) < rim.rx * 3 && Math.abs(b.v - rim.v) < rim.rx * 4;
      if (near) s.anyNearRim = true;
      if (b.v < rim.v - rim.ry && Math.abs(b.u - rim.u) < rim.rx * 3) st.above = true;
      if (st.above && st.prev && st.prev.v <= rim.v && b.v > rim.v) {
        const k = (rim.v - st.prev.v) / (b.v - st.prev.v), uc = st.prev.u + k * (b.u - st.prev.u);
        s.votes[cam] = Math.abs(uc - rim.u) < rim.rx * 0.95 ? 'made' : 'missed';
      }
      if (st.above && !s.votes[cam] && Math.abs(b.u - rim.u) > rim.rx * 4 && Math.abs(b.v - rim.v) < rim.rx * 6) s.votes[cam] = 'missed';
      st.prev = { u: b.u, v: b.v };
    }
  }
  finaliseShot(s, t) {
    const v = Object.values(s.votes), made = v.filter(x => x === 'made').length, missed = v.filter(x => x === 'missed').length;
    const reasons = []; let result = 'uncertain', confidence = 0;
    if (s.crossed3D !== null && s.crossed3D !== undefined) {
      const inside = s.crossed3D < this.model.d.rimRadius; result = inside ? 'made' : (s.crossed3D > this.model.d.rimRadius + 0.15 ? 'missed' : 'uncertain');
      confidence = result === 'uncertain' ? 0.4 : 0.92; reasons.push(`3-D ball crossed rim plane ${s.crossed3D.toFixed(2)} m from rim centre`);
    } else if (made && !missed) { result = 'made'; confidence = made >= 2 ? 0.88 : 0.6; reasons.push(`${made} camera(s) saw the ball pass down through the rim${made === 1 ? ' (single view: depth ambiguous)' : ''}`); }
    else if (missed && !made) { result = 'missed'; confidence = missed >= 2 ? 0.85 : 0.65; reasons.push(`${missed} camera(s) saw the ball leave the rim area without passing through`); }
    else if (made && missed) { result = 'uncertain'; confidence = 0.3; reasons.push('cameras disagree on the outcome'); }
    else reasons.push(s.anyNearRim ? 'ball near rim but crossing not observed (occluded / rim not calibrated)' : 'ball not tracked near a calibrated rim');
    return { type: 'shot_result', t, shotId: s.id, player: s.player, team: s.team, points: s.points, pointsUncertain: s.pointsUncertain, freeThrow: s.freeThrow, result, confidence, cams: Object.keys(s.votes), reasons, tRelease: s.t };
  }
}
