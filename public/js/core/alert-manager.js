// Referee alert queue: de-duplication, referee decisions (confirm / reject / review later) and audit trail.
export class AlertManager {
  constructor() { this.alerts = []; this.listeners = []; }
  on(f) { this.listeners.push(f); } emit(e) { for (const f of this.listeners) f(e); }
  /** Add an alert; alerts of the same type involving the same players within 2 s are merged (keeps the stronger). */
  add(a) {
    const dup = this.alerts.find(x => x.type === a.type && Math.abs(x.t - a.t) < 2 && x.decision === 'pending' && (x.players || []).join() === (a.players || []).join());
    if (dup) { if (a.confidence > dup.confidence) { Object.assign(dup, { ...a, id: dup.id, merged: (dup.merged || 0) + 1 }); this.emit({ type: 'alert_updated', alert: dup }); } return dup; }
    this.alerts.unshift(a); this.emit({ type: 'alert_new', alert: a }); return a;
  }
  decide(id, decision, note = '', by = 'referee') {
    const a = this.alerts.find(x => x.id === id); if (!a) return null;
    if (!['confirmed', 'rejected', 'review'].includes(decision)) throw new Error('bad decision');
    a.decision = decision; a.decidedBy = by; a.note = note; a.decidedAt = Date.now();
    this.emit({ type: 'alert_decision', alert: a }); return a;
  }
  pending() { return this.alerts.filter(a => a.decision === 'pending' || a.decision === 'review'); }
  get(id) { return this.alerts.find(a => a.id === id); }
}
