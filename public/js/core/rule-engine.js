// Basketball rule engine (FIBA default). Evaluates *sequences* of foot events, possession and
// actions over time. Every alert carries its reasons, the cameras used, timings and an evidence
// score. Alerts are never auto-confirmed: status is 'flagged' (evidence meets threshold, referee
// must confirm) or 'needs_review' (evidence incomplete / ambiguous => NEEDS HUMAN REVIEW).
// Evidence scores are heuristic and UNCALIBRATED until validated on labelled footage (see README).

let ALERT_ID = 1;
export function makeAlert(cfg, a) {
  const confidence = Math.max(0, Math.min(0.97, a.confidence));
  const status = a.forceReview || confidence < cfg.analysis.flagMinConfidence ? 'needs_review' : 'flagged';
  return { id: 'A' + (ALERT_ID++), decision: 'pending', ...a, confidence: Math.round(confidence * 100) / 100, status, createdAt: a.t };
}
export const ALERT_LABELS = {
  travelling: 'Travelling', double_dribble: 'Double dribble', carrying: 'Carrying / palming',
  ball_out_of_bounds: 'Ball out of bounds', player_out_of_bounds: 'Player with ball out of bounds',
  personal_foul: 'Personal foul', shooting_foul: 'Shooting foul', blocking_foul: 'Blocking foul',
  charging_foul: 'Charging foul', illegal_screen: 'Illegal screen', shot_clock: 'Shot-clock violation',
  score_confirmation: 'Confirm basket',
};

export class RuleEngine {
  /** ctx: {cfg (ruleset), model (CourtModel)} */
  constructor(ctx) { this.cfg = ctx.cfg; this.model = ctx.model; this.foot = new Map(); this.ctxs = new Map(); this.alerts = []; this.outState = new Map(); this.info = []; }

  /** footEvents: [{player, cam, primary:boolean, type, foot, t, court, q}] */
  addFootEvents(evs) {
    for (const e of evs) { const L = this.foot.get(e.player) || this.foot.set(e.player, []).get(e.player); L.push(e); L.sort((a, b) => a.t - b.t); while (L.length && L[L.length - 1].t - L[0].t > 12) L.shift(); }
  }
  /**
   * Process one analysis tick. actions: ActionRecognizer events, poss: possession output,
   * players: [{id, team, pos, vel, speed}], meta: {fps, possConfidence}
   */
  update(t, actions, poss, players, meta = {}) {
    const out = [];
    for (const a of actions) {
      if (a.type === 'gather') this.startCtx(a, players, meta);
      else if (a.type === 'dribble_start') { out.push(...this.endCtx(a.player, a.t, 'dribble', meta)); out.push(...this.checkDoubleDribble(a, meta)); }
      else if (a.type === 'shot') out.push(...this.endCtx(a.player, a.t, 'shot', meta));
      else if (a.type === 'pass' || a.type === 'turnover') out.push(...this.endCtx(a.from, a.t, 'pass', meta));
      else if (a.type === 'carry_suspect') out.push(this.carryAlert(a, meta));
      else if (a.type === 'ball_bounce') { const al = this.ballOutCheck(a, poss); if (al) out.push(al); }
    }
    if (poss.changed && poss.prevController) out.push(...this.endCtx(poss.prevController, poss.releaseT ?? t, 'release', meta));
    // live checks for the current ball handler (violations can be flagged before the release)
    for (const [pid, c] of this.ctxs) if (!c.reported) { const v = this.evaluateTravel(c, t, null); if (v && v.immediate) out.push(this.travelAlert(c, v, meta)); }
    if (poss.controller) { const al = this.playerOutCheck(poss.controller, t, players, poss); if (al) out.push(al); }
    this.trackPlayersOut(t, players);
    this.alerts.push(...out);
    return out;
  }

  startCtx(g, players, meta) {
    const p = players.find(x => x.id === g.player);
    const speed = p?.speed ?? (p?.vel ? Math.hypot(...p.vel) : 0);
    this.ctxs.set(g.player, { player: g.player, team: g.team, tg: g.t, kind: g.kind, fromDribble: !!g.fromDribble, progressing: g.fromDribble || speed > 1.0, speed, reported: false, possConf: meta.possConfidence ?? 0.7 });
  }
  endCtx(pid, tr, how, meta) {
    const c = this.ctxs.get(pid); if (!c) return []; this.ctxs.delete(pid);
    if (c.reported) return [];
    const v = this.evaluateTravel(c, tr, how);
    return v ? [this.travelAlert(c, v, meta, tr, how)] : [];
  }

  /** Replay the handler's primary-camera foot events from the gather point. Returns violation or null. */
  evaluateTravel(c, tEnd, releaseKind) {
    const all = (this.foot.get(c.player) || []).filter(e => e.primary !== false);
    const stateAt = foot => { let s = 'unknown'; for (const e of all) { if (e.t > c.tg) break; if (e.foot === foot) s = e.type === 'plant' ? 'grounded' : e.type === 'lift' ? 'lifted' : s; } return s; };
    const g0 = { L: stateAt('L'), R: stateAt('R') };
    const evs = all.filter(e => e.t > c.tg && e.t <= tEnd);
    const steps = [], seq = [`gather at ${c.tg.toFixed(2)}s (feet: L ${g0.L}, R ${g0.R}; ${c.progressing ? 'moving' : 'stationary'})`];
    const allowed = this.cfg.travelling.stepsAfterGather;
    let mode = c.progressing ? 'progress' : (g0.L === 'grounded' && g0.R === 'grounded' ? 'stationary' : 'progress');
    let pivot = null, pivotLiftedAt = null, airborneAt = null, pendingStop = null; const grounded = { ...g0 }; const STOP_HOLD = 0.3;
    for (const e of evs) {
      if (e.type === 'jump') { airborneAt = e.t; seq.push(`jump at ${e.t.toFixed(2)}s`); continue; }
      if (e.type === 'land') {
        seq.push(`landing (${e.feet}) at ${e.t.toFixed(2)}s`);
        if (airborneAt !== null) return { rule: 'jump', at: e.t, events: [e], seq, immediate: true, reason: 'Player jumped while holding the ball and landed again before releasing it (FIBA Art. 25.2.3).' };
        continue;
      }
      if (e.type === 'lift') {
        // a double-support phase only counts as "coming to a stop" if both feet stayed down long enough
        // (or the player was nearly stationary); otherwise it was just a walking/running stride.
        if (pendingStop) {
          if (e.t - pendingStop.t >= STOP_HOLD || (pendingStop.speed !== undefined && pendingStop.speed < 0.5)) { mode = 'stationary'; pivot = pendingStop.pivot; pivotLiftedAt = null; seq.push(`came to a stop at ${pendingStop.t.toFixed(2)}s, pivot = ${pivot}`); }
          pendingStop = null;
        }
        grounded[e.foot] = 'lifted'; seq.push(`${e.foot} foot lifts at ${e.t.toFixed(2)}s`);
        if (mode === 'stationary') {
          if (!pivot) pivot = e.foot === 'L' ? 'R' : 'L';
          else if (e.foot === pivot && pivotLiftedAt === null) pivotLiftedAt = e.t;
        }
        continue;
      }
      if (e.type === 'plant') {
        grounded[e.foot] = 'grounded'; seq.push(`${e.foot} foot touches floor at ${e.t.toFixed(2)}s`);
        if (mode === 'stationary') {
          if (pivot && e.foot === pivot && pivotLiftedAt !== null) return { rule: 'pivot', at: e.t, events: [e], seq, immediate: true, reason: `Pivot foot (${pivot}) was lifted and returned to the floor before the ball was released (FIBA Art. 25.2.1).` };
          continue;
        }
        // progressing: count steps after the gather (a foot already on the floor at the gather is the zero step)
        steps.push(e);
        if (steps.length > allowed) return { rule: 'steps', at: e.t, events: steps.slice(), seq, immediate: true, reason: `${steps.length} steps after gaining control (max ${allowed}${this.cfg.travelling.allowZeroStep ? ' plus gather/zero step' : ''}) without passing, shooting or dribbling (FIBA Art. 25.2.2).` };
        if (grounded.L === 'grounded' && grounded.R === 'grounded') pendingStop = { t: e.t, speed: e.speed, pivot: steps.length === 1 ? e.foot : steps[0].foot };
      }
    }
    if (releaseKind === 'dribble' && mode === 'stationary' && pivot && pivotLiftedAt !== null && pivotLiftedAt < tEnd)
      return { rule: 'dribble_pivot', at: pivotLiftedAt, events: [], seq, immediate: false, reason: `Pivot foot (${pivot}) left the floor before the ball left the hand to start a dribble (FIBA Art. 25.2.1).` };
    return null;
  }
  travelAlert(c, v, meta, tr = null, how = null) {
    c.reported = true;
    const evs = v.events.length ? v.events : [];
    const q = evs.length ? evs.reduce((s, e) => s + (e.q ?? 0.5), 0) / evs.length : 0.5;
    const nearBoundary = tr !== null && Math.abs(tr - v.at) < 0.12 ? 0.6 : 1; // close to release: frame-timing ambiguity
    const fpsF = (meta.fps ?? 15) < 12 ? 0.8 : 1;
    let corr = 0; const cams = new Set(evs.map(e => e.cam));
    const sec = (this.foot.get(c.player) || []).filter(e => e.primary === false);
    for (const e of evs) { const m = sec.find(s => s.type === e.type && Math.abs(s.t - e.t) < 0.1); if (m) { corr += 0.15 / evs.length; cams.add(m.cam); } }
    const confidence = q * c.possConf * nearBoundary * fpsF + corr;
    return makeAlert(this.cfg, { type: 'travelling', label: ALERT_LABELS.travelling, t: v.at, tStart: c.tg - 0.5, tEnd: (tr ?? v.at) + 0.7, players: [c.player], team: c.team, confidence, cams: [...cams], reasons: [v.reason, ...v.seq], evidence: { rule: v.rule, gatherT: c.tg, releaseT: tr, release: how, footQuality: q, possConf: c.possConf }, forceReview: q < 0.6 });
  }

  checkDoubleDribble(a, meta) {
    if (!this.cfg.dribble.doubleDribbleEnabled || !a.afterDribbleEnded) return [];
    if (!a.continuousControl) return [];
    const conf = (a.possConf ?? meta.possConfidence ?? 0.7) * 0.85;
    return [makeAlert(this.cfg, { type: 'double_dribble', label: ALERT_LABELS.double_dribble, t: a.t, tStart: a.t - 2.5, tEnd: a.t + 1, players: [a.player], team: a.team, confidence: conf, cams: [], reasons: ['Player ended a dribble (caught/held the ball) and started a new dribble without another player touching the ball and without a shot (FIBA Art. 24.1.3).'], evidence: { dribbleRestartT: a.t } })];
  }
  carryAlert(a, meta) {
    const ev = a.evidence; const conf = 0.35 + 0.3 * (ev.handBelowFraction - 0.6) / 0.4 + 0.1 * Math.min(1, (ev.duration - this.cfg.analysis.carryMinContactSec) / 0.3);
    return makeAlert(this.cfg, { type: 'carrying', label: ALERT_LABELS.carrying, t: a.t, tStart: a.t - 1.5, tEnd: (a.tEnd ?? a.t) + 1, players: [a.player], team: a.team, confidence: conf, cams: [], reasons: [`During a dribble the hand stayed under the ball for ${ev.duration.toFixed(2)} s (${Math.round(ev.handBelowFraction * 100)} % of contact frames) while the ball moved upward with it, then the dribble continued (FIBA Art. 24.1.2: ball comes to rest in the hand).`], evidence: ev, forceReview: true });
  }

  ballOutCheck(b, poss) {
    const m = this.model.insideMargin(b.court), sig = Math.max(this.cfg.analysis.boundaryUncertaintyMin, b.sigma || 0);
    if (m > sig) return null;
    const certain = m < -sig;
    return makeAlert(this.cfg, { type: 'ball_out_of_bounds', label: ALERT_LABELS.ball_out_of_bounds, t: b.t, tStart: b.t - 2, tEnd: b.t + 1, players: poss.lastController ? [poss.lastController] : [], team: poss.lastControllerTeam ?? null, confidence: certain ? 0.75 : 0.45, cams: b.cam ? [b.cam] : [], reasons: [`Ball touched the floor ${m <= 0 ? (-m).toFixed(2) + ' m outside' : m.toFixed(2) + ' m inside'} the boundary (±${sig.toFixed(2)} m uncertainty). In FIBA the boundary line itself is out.`, poss.lastController ? `Last controlled by ${poss.lastController}.` : 'Last player to touch not determined.'], evidence: { court: b.court, margin: m, sigma: sig }, forceReview: !certain });
  }
  playerOutCheck(pid, t, players, poss) {
    const evs = (this.foot.get(pid) || []).filter(e => e.type === 'plant' && e.court && e.t > (t - 0.6) && e.primary !== false);
    const st = this.outState.get(pid) || {}; const last = evs[evs.length - 1]; if (!last) return null;
    const m = this.model.insideMargin(last.court), sig = Math.max(this.cfg.analysis.boundaryUncertaintyMin, last.sigma || 0.1);
    if (m > sig || (st.reportedAt && t - st.reportedAt < 3)) return null;
    st.reportedAt = t; this.outState.set(pid, st);
    const certain = m < -sig;
    return makeAlert(this.cfg, { type: 'player_out_of_bounds', label: ALERT_LABELS.player_out_of_bounds, t: last.t, tStart: last.t - 2, tEnd: last.t + 1, players: [pid], team: poss.team, confidence: (certain ? 0.75 : 0.45) * (last.q ?? 0.7), cams: [last.cam], reasons: [`Ball handler's ${last.foot} foot touched the floor ${m <= 0 ? (-m).toFixed(2) + ' m beyond' : m.toFixed(2) + ' m inside'} the boundary line inner edge (±${sig.toFixed(2)} m).`], evidence: { court: last.court, margin: m }, forceReview: !certain });
  }
  trackPlayersOut(t, players) { // informational: players (without ball) standing out of bounds
    for (const p of players) { const out = p.pos && this.model.insideMargin(p.pos) < -0.3; const st = this.outState.get(p.id) || {}; if (out && !st.out) this.info.push({ type: 'player_out', t, player: p.id, pos: p.pos }); st.out = out; this.outState.set(p.id, st); }
  }
}
