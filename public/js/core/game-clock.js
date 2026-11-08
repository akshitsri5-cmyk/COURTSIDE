// Game clock + shot clock. Drift-free: remaining time is computed from a monotonic time source
// (performance.now in the browser), never by counting setInterval ticks. The time source is
// injectable so accuracy can be unit-tested deterministically.
export class GameClock {
  constructor(timing, now = () => (globalThis.performance ? performance.now() : Date.now())) {
    this.timing = timing; this.now = now; this.listeners = [];
    this.period = 1; this.running = false; this.baseMs = timing.periodSec * 1000; this.startedAt = null;
    this.shotBaseMs = timing.shotClock * 1000; this.shotStartedAt = null; this.shotEnabled = true;
    this.autoManage = true; this.expired = false; this.shotExpired = false;
  }
  on(fn) { this.listeners.push(fn); }
  emit(e) { for (const f of this.listeners) f({ ...e, period: this.period, remainingMs: this.remainingMs() }); }
  remainingMs() { return Math.max(0, this.running ? this.baseMs - (this.now() - this.startedAt) : this.baseMs); }
  shotRemainingMs() { return Math.max(0, this.running && this.shotStartedAt !== null ? this.shotBaseMs - (this.now() - this.shotStartedAt) : this.shotBaseMs); }
  start(reason = 'manual') {
    if (this.running || this.remainingMs() <= 0) return false;
    const n = this.now(); this.running = true; this.startedAt = n; this.shotStartedAt = n; this.emit({ type: 'clock_start', reason }); return true;
  }
  pause(reason = 'manual') {
    if (!this.running) return false;
    this.baseMs = this.remainingMs(); this.shotBaseMs = this.shotRemainingMs(); this.running = false; this.startedAt = null; this.shotStartedAt = null;
    this.emit({ type: 'clock_stop', reason }); return true;
  }
  toggle() { return this.running ? this.pause() : this.start(); }
  periodLengthMs(p = this.period) { return (p > this.timing.periods ? this.timing.overtimeSec : this.timing.periodSec) * 1000; }
  resetPeriod() { this.pause('reset'); this.baseMs = this.periodLengthMs(); this.resetShotClock(this.timing.shotClock, 'reset'); this.expired = false; this.emit({ type: 'clock_reset' }); }
  resetGame() { this.period = 1; this.resetPeriod(); }
  nextPeriod() { this.pause('period'); this.period++; this.baseMs = this.periodLengthMs(); this.resetShotClock(this.timing.shotClock, 'period'); this.expired = false; this.emit({ type: 'period_start' }); }
  setRemaining(ms) { const r = this.running; if (r) this.pause('adjust'); this.baseMs = Math.max(0, ms); this.expired = false; if (r) this.start('adjust'); this.emit({ type: 'clock_adjust' }); }
  resetShotClock(sec = this.timing.shotClock, reason = 'manual') {
    this.shotBaseMs = sec * 1000; this.shotStartedAt = this.running ? this.now() : null; this.shotExpired = false; this.emit({ type: 'shot_clock_reset', seconds: sec, reason });
  }
  /** Call regularly (e.g. every animation frame). Emits expiry events exactly once. */
  tick() {
    if (this.running && this.remainingMs() <= 0 && !this.expired) { this.expired = true; this.baseMs = 0; this.running = false; this.emit({ type: 'period_end' }); }
    if (this.running && this.shotEnabled && this.shotRemainingMs() <= 0 && !this.shotExpired && this.remainingMs() > 0) { this.shotExpired = true; this.emit({ type: 'shot_clock_expired' }); }
  }
  isLastMinutesOfLatePeriod() {
    const t = this.timing, lateP = this.period >= t.periods; return lateP && this.remainingMs() <= t.stopClockAfterMadeBasketLastSec * 1000;
  }
  // ---- automatic management hooks (only act when autoManage is on) ----
  onMadeBasket() { if (this.autoManage && this.isLastMinutesOfLatePeriod()) this.pause('made basket in last 2:00 of 4th/OT (FIBA Art. 49.2)'); if (this.autoManage) this.resetShotClock(this.timing.shotClock, 'made basket'); }
  onPossessionChange(newTeam, prevTeam, { offensiveReboundAfterRim = false } = {}) {
    if (!this.autoManage) return;
    if (offensiveReboundAfterRim) this.resetShotClock(this.timing.shotClockOffensiveRebound, 'offensive rebound after rim contact (FIBA Art. 29.2.2)');
    else if (newTeam !== null && prevTeam !== null && newTeam !== prevTeam) this.resetShotClock(this.timing.shotClock, 'change of team control');
  }
  onConfirmedWhistle(reason) { if (this.autoManage) this.pause(reason); }
  static format(ms) {
    if (ms < 60000) { const s = ms / 1000; return s.toFixed(1).padStart(4, '0'); }
    const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  snapshot() { return { period: this.period, remainingMs: this.remainingMs(), running: this.running, shotMs: this.shotRemainingMs(), autoManage: this.autoManage }; }
}
