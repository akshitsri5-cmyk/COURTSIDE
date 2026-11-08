// Match recording: time-indexed frame ring buffer per camera (for evidence clips) and a
// serialisable match event log. Frame payloads are opaque (Blob/ImageBitmap in the browser).
export class FrameRing {
  constructor(maxSec = 12) { this.maxSec = maxSec; this.frames = []; }
  push(t, payload, meta = {}) { this.frames.push({ t, payload, meta }); while (this.frames.length && t - this.frames[0].t > this.maxSec) { this.frames.shift(); } }
  range(t0, t1) { return this.frames.filter(f => f.t >= t0 && f.t <= t1); }
  get span() { return this.frames.length ? [this.frames[0].t, this.frames[this.frames.length - 1].t] : null; }
}

export class MatchRecorder {
  constructor(matchId) { this.matchId = matchId; this.events = []; this.rings = new Map(); this.clips = new Map(); this.listeners = []; }
  on(f) { this.listeners.push(f); }
  ring(cam, maxSec) { return this.rings.get(cam) || this.rings.set(cam, new FrameRing(maxSec)).get(cam); }
  log(type, data = {}, t = null) { const e = { seq: this.events.length + 1, type, t, wall: new Date().toISOString(), ...data }; this.events.push(e); for (const f of this.listeners) f(e); return e; }
  /** Snapshot frames for an alert from all cameras listed (or all). Frames are copied by reference. */
  captureClip(id, t0, t1, cams = null) {
    const clip = {}; for (const [cam, r] of this.rings) if (!cams || !cams.length || cams.includes(cam)) { const f = r.range(t0, t1); if (f.length) clip[cam] = f; }
    this.clips.set(id, { t0, t1, frames: clip }); return this.clips.get(id);
  }
  toJSON() { return { matchId: this.matchId, events: this.events }; }
}
