// Score management with de-duplication, confidence gating, human confirmation and undo.
export class ScoreManager {
  constructor({ autoMinConfidence = 0.85, dedupeWindowSec = 1.5 } = {}) {
    this.score = { home: 0, away: 0 }; this.history = []; this.pending = []; this.seenShots = new Set();
    this.autoMin = autoMinConfidence; this.dedupe = dedupeWindowSec; this.teamMap = { 0: 'home', 1: 'away' }; this.autoEnabled = true; this.listeners = [];
  }
  on(f) { this.listeners.push(f); } emit(e) { for (const f of this.listeners) f(e); }
  sideOf(team) { return team === 'home' || team === 'away' ? team : (team === null || team === undefined ? null : this.teamMap[team]); }
  add(team, points, meta = {}) {
    const side = this.sideOf(team); if (!side || !Number.isFinite(points)) return null;
    this.score[side] = Math.max(0, this.score[side] + points);
    const entry = { id: 'G' + (this.history.length + 1) + '-' + Date.now().toString(36), side, points, t: meta.t ?? null, source: meta.source || 'manual', shotId: meta.shotId || null, note: meta.note || '' };
    this.history.push(entry); this.emit({ type: 'score', entry, score: { ...this.score } }); return entry;
  }
  undo() { const e = this.history.pop(); if (!e) return null; this.score[e.side] = Math.max(0, this.score[e.side] - e.points); if (e.shotId) this.seenShots.delete(e.shotId); this.emit({ type: 'score_undo', entry: e, score: { ...this.score } }); return e; }
  /**
   * Handle an automatic shot_result. Returns {action:'applied'|'pending'|'ignored'|'duplicate', reason}.
   * Points are added automatically only for a confident 'made' result with certain points and a known team.
   */
  handleShotResult(r) {
    if (r.result === 'missed') return { action: 'ignored', reason: 'missed shot' };
    if (this.seenShots.has(r.shotId)) return { action: 'duplicate', reason: 'shot already scored' };
    const side = this.sideOf(r.team);
    const dup = side && this.history.find(h => h.side === side && h.t !== null && r.t !== undefined && Math.abs(h.t - r.t) < this.dedupe && h.source === 'auto');
    if (dup) { this.seenShots.add(r.shotId); return { action: 'duplicate', reason: 'basket for this team already counted ' + Math.abs(dup.t - r.t).toFixed(1) + ' s ago' }; }
    const reasons = [];
    if (r.result !== 'made') reasons.push('could not confirm the ball went through the rim');
    if (r.confidence < this.autoMin) reasons.push(`outcome evidence ${r.confidence.toFixed(2)} < auto threshold ${this.autoMin}`);
    if (r.pointsUncertain) reasons.push('shooter position too close to the 3-point line to decide 2 vs 3');
    if (!side) reasons.push('shooting team unknown');
    if (!this.autoEnabled) reasons.push('automatic scoring disabled');
    if (!reasons.length) { this.seenShots.add(r.shotId); this.add(side, r.points, { t: r.t, source: 'auto', shotId: r.shotId, note: r.reasons?.join('; ') }); return { action: 'applied' }; }
    if (this.pending.some(p => p.shotId === r.shotId)) return { action: 'duplicate', reason: 'already awaiting confirmation' };
    const p = { ...r, side, pendingReasons: reasons }; this.pending.push(p); this.emit({ type: 'score_pending', pending: p }); return { action: 'pending', reason: reasons.join('; ') };
  }
  /** Referee answer for a pending basket: points (0 = no basket) and side override. */
  resolvePending(shotId, { points, side } = {}) {
    const i = this.pending.findIndex(p => p.shotId === shotId); if (i < 0) return null;
    const p = this.pending.splice(i, 1)[0]; this.seenShots.add(shotId);
    const s = side || p.side, pts = points ?? p.points;
    if (pts > 0 && s) return this.add(s, pts, { t: p.t, source: 'confirmed', shotId });
    this.emit({ type: 'score_rejected', pending: p }); return null;
  }
  reset() { this.score = { home: 0, away: 0 }; this.history = []; this.pending = []; this.seenShots.clear(); this.emit({ type: 'score_reset', score: { ...this.score } }); }
  toJSON() { return { score: this.score, history: this.history, pending: this.pending.map(p => ({ shotId: p.shotId, points: p.points, side: p.side, reasons: p.pendingReasons })) }; }
}
