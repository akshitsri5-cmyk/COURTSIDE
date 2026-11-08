// Foul detection. Bounding-box overlap is NEVER treated as a foul. A contact candidate requires:
//   * limb/torso segments of the two players' POSES within a few cm-equivalents in a camera view,
//   * the players being physically close on the court plane (rejects depth-overlap illusions),
//   * no calibrated view clearly showing them separated at the same time,
//   * temporal persistence (multi-frame contact episode),
// and is then classified with context (ball handler, shooter, screen, defender position/motion,
// restricted area) and impact (change of velocity). Most outputs are NEEDS HUMAN REVIEW by design.
import { LIMB_SEGMENTS, TORSO, segSegDist, bodyHeight, armExtension, handsAboveShoulders } from './pose-analysis.js';
import { makeAlert, ALERT_LABELS } from './rule-engine.js';

const ARM = new Set([11, 13, 15, 12, 14, 16, 19, 20]);
function segments(pose) {
  const v = i => pose[i] && (pose[i].v ?? 1) > 0.4; const P = i => [pose[i].x, pose[i].y];
  const segs = [];
  for (const [a, b] of LIMB_SEGMENTS) if (v(a) && v(b)) segs.push({ a: P(a), b: P(b), arm: ARM.has(b), ids: [a, b] });
  for (let k = 0; k < TORSO.length; k++) { const a = TORSO[k], b = TORSO[(k + 1) % TORSO.length]; if (v(a) && v(b)) segs.push({ a: P(a), b: P(b), torso: true, ids: [a, b] }); }
  return segs;
}
/** Minimum normalised distance between two poses + which body parts are involved. */
export function poseContact(poseA, bboxA, poseB, bboxB) {
  const Hb = (bodyHeight(poseA, bboxA) + bodyHeight(poseB, bboxB)) / 2;
  const SA = segments(poseA), SB = segments(poseB); let best = { d: Infinity };
  for (const sa of SA) for (const sb of SB) { const d = segSegDist(sa.a, sa.b, sb.a, sb.b) / Hb; if (d < best.d) best = { d, aArm: !!sa.arm, bArm: !!sb.arm, aTorso: !!sa.torso, bTorso: !!sb.torso }; }
  return best;
}

export class FoulDetector {
  constructor(ctx) { this.cfg = ctx.cfg; this.model = ctx.model; this.episodes = new Map(); this.closing = []; this.recentShots = []; }
  noteAction(a) { if (a.type === 'shot') { this.recentShots.push(a); while (this.recentShots.length > 10) this.recentShots.shift(); } }
  /**
   * players: [{id, team, pos, vel, isReferee, airborne, groundedFeet, views:{cam:{bbox,pose}}, history: (t)=>{p,v}}]
   * poss: possession output. Returns new alerts.
   */
  update(t, players, poss) {
    const A = this.cfg.analysis, out = [];
    const ps = players.filter(p => !p.isReferee && p.pos);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.team !== null && a.team !== undefined && a.team === b.team) continue; // same team: no foul between team-mates
      const cd = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      let contactViews = [], sepViews = [], parts = null;
      if (cd <= A.contactMaxCourtDist) {
        for (const cam of Object.keys(a.views || {})) {
          const va = a.views[cam], vb = b.views?.[cam]; if (!va?.pose || !vb?.pose) continue;
          const c = poseContact(va.pose, va.bbox, vb.pose, vb.bbox);
          if (c.d < A.contactDist) { contactViews.push(cam); parts = parts || (a.id < b.id ? c : { d: c.d, aArm: c.bArm, bArm: c.aArm, aTorso: c.bTorso, bTorso: c.aTorso }); }
          else if (c.d > 0.15) sepViews.push(cam);
        }
      }
      let ep = this.episodes.get(key);
      if (contactViews.length && !sepViews.length) {
        if (!ep) { ep = { key, ids: key.split('|'), start: t, last: t, frames: 0, cams: new Set(), checked: new Set(), parts: [], ctx: this.context(t, a, b, poss) }; this.episodes.set(key, ep); }
        ep.last = t; ep.frames++; contactViews.forEach(c => ep.cams.add(c)); if (parts) ep.parts.push(parts);
      } else if (contactViews.length && sepViews.length && ep) { ep.contradicted = (ep.contradicted || 0) + 1; }
      // Fouls happen at contact ONSET: evaluate ~0.65 s after onset (impact window), keep the episode open to avoid duplicates.
      if (ep && !ep.queued && ep.frames >= 2 && t - ep.start >= 0.65) { ep.queued = true; this.closing.push({ ep, evalAt: t }); }
      if (ep && t - ep.last > 0.25) { this.episodes.delete(key); if (!ep.queued && ep.frames >= 2) { ep.queued = true; this.closing.push({ ep, evalAt: Math.max(t, ep.start + 0.65) }); } }
    }
    // evaluate closed episodes once post-contact velocities are available
    for (const c of [...this.closing]) {
      if (t < c.evalAt) continue; this.closing.splice(this.closing.indexOf(c), 1);
      const al = this.classify(c.ep, t, ps); if (al) out.push(al);
    }
    return out;
  }
  context(t, a, b, poss) {
    const handler = poss.controller || null, offenseTeam = poss.team ?? poss.lastControllerTeam ?? null;
    const shooter = this.recentShots.find(s => t - s.t < 1.0 && t - s.t > -0.4 && (s.player === a.id || s.player === b.id))?.player
      || [a, b].find(p => p.id === handler && p.airborne && Object.values(p.views || {}).some(v => handsAboveShoulders(v.pose)))?.id || null;
    const snap = p => ({ id: p.id, team: p.team, pos: p.pos.slice(), vel: (p.vel || [0, 0]).slice(), grounded: p.groundedFeet ?? null, airborne: !!p.airborne, ext: Math.max(0, ...Object.values(p.views || {}).map(v => armExtension(v.pose, bodyHeight(v.pose, v.bbox)) || 0)) });
    return { handler, offenseTeam, shooter, a: snap(a), b: snap(b), t };
  }
  classify(ep, t, players) {
    const A = this.cfg.analysis, C = ep.ctx, [ia, ib] = ep.ids;
    const P = id => players.find(p => p.id === id);
    const before = id => { const p = P(id); const h = p?.history?.(ep.start - 0.3); return h ? h.v : (id === C.a.id ? C.a.vel : C.b.vel); };
    const after = id => { const p = P(id); const h = p?.history?.(ep.start + 0.4); return h ? h.v : (p?.vel || [0, 0]); };
    const dv = id => { const v0 = before(id), v1 = after(id); return Math.hypot(v1[0] - v0[0], v1[1] - v0[1]); };
    const impact = Math.max(dv(ia), dv(ib)), hasImpact = impact > A.impactDeltaV;
    const sa = C.a.id === ia ? C.a : C.b, sb = C.a.id === ia ? C.b : C.a;
    const toward = (s, o) => { const d = [o.pos[0] - s.pos[0], o.pos[1] - s.pos[1]], n = Math.hypot(...d) || 1, v = before(s.id); return (v[0] * d[0] + v[1] * d[1]) / n; };
    const armsA = ep.parts.filter(p => p.aArm).length / ep.parts.length, armsB = ep.parts.filter(p => p.bArm).length / ep.parts.length;
    const corroborated = ep.cams.size >= 2, teamsKnown = sa.team !== null && sa.team !== undefined && sb.team !== null && sb.team !== undefined;
    const reasons = [`Pose contact between ${ia} and ${ib} for ${(ep.last - ep.start + 0.03).toFixed(2)} s (${ep.frames} frames so far) in ${ep.cams.size} camera view(s); court distance ${Math.hypot(sa.pos[0] - sb.pos[0], sa.pos[1] - sb.pos[1]).toFixed(2)} m.`, hasImpact ? `Impact: velocity change ${impact.toFixed(1)} m/s.` : `No clear impact (velocity change ${impact.toFixed(1)} m/s).`];
    if (ep.contradicted) reasons.push(`${ep.contradicted} frame(s) where another view showed separation.`);
    let type = null, fouler = null;
    const pick = (x, y) => [x, y];
    const [shooter, other] = C.shooter === ia ? pick(sa, sb) : C.shooter === ib ? pick(sb, sa) : [null, null];
    const [handler, def] = C.handler === ia ? pick(sa, sb) : C.handler === ib ? pick(sb, sa) : [null, null];
    if (shooter) { type = 'shooting_foul'; fouler = other.id; reasons.push(`${shooter.id} was in the act of shooting; contact by ${other.id}.`); }
    else if (handler) {
      const defStill = Math.hypot(...before(def.id)) < A.defenderStationarySpeed && (def.grounded === null || def.grounded >= 2);
      const inRA = this.cfg.fouls.noChargeSemiCircle && this.model.inRestrictedArea(def.pos);
      const hApp = toward(handler, def), dApp = toward(def, handler);
      reasons.push(`Ball handler ${handler.id} approach speed ${hApp.toFixed(1)} m/s; defender ${def.id} speed ${Math.hypot(...before(def.id)).toFixed(1)} m/s (toward handler ${dApp.toFixed(1)} m/s)${inRA ? '; defender inside the no-charge semi-circle' : ''}.`);
      if (hApp > 1.0 && defStill && !inRA) { type = 'charging_foul'; fouler = handler.id; reasons.push('Defender had an established, stationary position in the path; contact initiated by the ball handler.'); }
      else if (dApp > 0.8 || (inRA && hApp > 1.0)) { type = 'blocking_foul'; fouler = def.id; reasons.push(inRA ? 'Defender inside the no-charge semi-circle (FIBA Art. 33.10): cannot draw a charge.' : 'Defender was moving into the ball handler\'s path at contact.'); }
      else { type = 'personal_foul'; fouler = def.id; reasons.push((def.id === ia ? armsA : armsB) > 0.5 ? 'Defender\'s arm/hand in contact with the ball handler (possible hand-check/holding/reach).' : 'Contact type unclear.'); }
    } else if (C.offenseTeam !== null && teamsKnown) {
      const [scr, dfd] = sa.team === C.offenseTeam ? [sa, sb] : [sb, sa];
      const moving = Math.hypot(...before(scr.id)) > A.screenerMovingSpeed, extended = scr.ext > 0.45;
      if (moving || extended) { type = 'illegal_screen'; fouler = scr.id; reasons.push(`Off-ball offensive player ${scr.id} set a screen while ${moving ? `moving (${Math.hypot(...before(scr.id)).toFixed(1)} m/s)` : ''}${moving && extended ? ' and ' : ''}${extended ? 'with limbs extended away from the body' : ''} (FIBA Art. 33.7).`); }
      else if (hasImpact) { type = 'personal_foul'; fouler = dfd.id; reasons.push('Off-ball contact with impact; screener was stationary (legal screen) — check defender.'); }
      else return null; // legal screen without impact: not reported
    } else if (hasImpact) { type = 'personal_foul'; fouler = null; reasons.push('Off-ball contact with impact; teams/ball possession unknown.'); }
    else return null;
    let conf = 0.55 * (corroborated ? 1 : 0.75) * (hasImpact ? 1 : 0.6) * (teamsKnown ? 1 : 0.7) + (type === 'shooting_foul' && hasImpact ? 0.1 : 0) + (corroborated && hasImpact ? 0.15 : 0);
    if (ep.contradicted) conf *= 0.6;
    return makeAlert(this.cfg, { type, label: ALERT_LABELS[type], t: ep.start, tStart: ep.start - 2, tEnd: ep.last + 1.5, players: [fouler, ...ep.ids.filter(x => x !== fouler)].filter(Boolean), fouler, team: P(fouler)?.team ?? null, confidence: conf, cams: [...ep.cams], reasons, evidence: { impact, frames: ep.frames, corroborated, armsA, armsB }, forceReview: !(corroborated && hasImpact) });
  }
}
