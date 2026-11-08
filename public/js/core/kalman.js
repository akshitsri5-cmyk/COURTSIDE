// Constant-velocity / constant-acceleration Kalman filters (per axis, decoupled).
// Decoupled axes keep the filters tiny and fast enough to run for every track at video rate.

export class KF1D {
  /** order 2 = [pos, vel]; order 3 = [pos, vel, acc]. q = process noise spectral density, r = measurement variance. */
  constructor(x0, { order = 2, q = 1, r = 1, v0 = 0, p0 = 10, pv0 = 100 } = {}) {
    this.n = order; this.q = q; this.r = r;
    this.x = order === 2 ? [x0, v0] : [x0, v0, 0];
    this.P = this.x.map((_, i) => this.x.map((__, j) => i === j ? (i === 0 ? p0 : pv0) : 0));
  }
  predict(dt) {
    if (dt <= 0) return; const n = this.n, q = this.q;
    const F = n === 2 ? [[1, dt], [0, 1]] : [[1, dt, dt * dt / 2], [0, 1, dt], [0, 0, 1]];
    const Q = n === 2
      ? [[q * dt ** 3 / 3, q * dt ** 2 / 2], [q * dt ** 2 / 2, q * dt]]
      : [[q * dt ** 5 / 20, q * dt ** 4 / 8, q * dt ** 3 / 6], [q * dt ** 4 / 8, q * dt ** 3 / 3, q * dt ** 2 / 2], [q * dt ** 3 / 6, q * dt ** 2 / 2, q * dt]];
    this.x = F.map(row => row.reduce((s, f, j) => s + f * this.x[j], 0));
    const FP = F.map(row => this.P[0].map((_, j) => row.reduce((s, f, k) => s + f * this.P[k][j], 0)));
    this.P = FP.map((row, i) => F.map((frow, j) => row.reduce((s, v, k) => s + v * frow[k], 0) + Q[i][j]));
  }
  /** Innovation (Mahalanobis^2) of a measurement without updating. */
  mahal(z) { const S = this.P[0][0] + this.r; return (z - this.x[0]) ** 2 / S; }
  update(z, r = this.r) {
    const S = this.P[0][0] + r, K = this.P.map(row => row[0] / S), y = z - this.x[0];
    this.x = this.x.map((v, i) => v + K[i] * y);
    const P0 = this.P[0].slice(); this.P = this.P.map((row, i) => row.map((v, j) => v - K[i] * P0[j]));
  }
  get pos() { return this.x[0]; } get vel() { return this.x[1]; } get acc() { return this.n === 3 ? this.x[2] : 0; }
  get std() { return Math.sqrt(Math.max(0, this.P[0][0])); }
}

/** 2-D point filter built from two KF1D. */
export class KF2D {
  constructor([x, y], opts = {}) { this.fx = new KF1D(x, opts); this.fy = new KF1D(y, opts); }
  predict(dt) { this.fx.predict(dt); this.fy.predict(dt); }
  update([x, y], r) { this.fx.update(x, r); this.fy.update(y, r); }
  mahal([x, y]) { return this.fx.mahal(x) + this.fy.mahal(y); }
  get pos() { return [this.fx.pos, this.fy.pos]; } get vel() { return [this.fx.vel, this.fy.vel]; }
  get acc() { return [this.fx.acc, this.fy.acc]; } get std() { return Math.hypot(this.fx.std, this.fy.std); }
  peek(dt) { return [this.fx.pos + this.fx.vel * dt + 0.5 * this.fx.acc * dt * dt, this.fy.pos + this.fy.vel * dt + 0.5 * this.fy.acc * dt * dt]; }
}
