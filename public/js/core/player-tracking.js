// Per-camera multi-object tracker for players (ByteTrack-style two-stage association + Kalman motion
// model + appearance gallery for re-identification after occlusion). Time-based (seconds), so it is
// robust to irregular analysis frame rates.
import { KF1D } from './kalman.js';
import { hungarian } from './hungarian.js';
import { appearanceDistance, blendEmbedding } from './appearance.js';

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
}

let NEXT = 1;
export class Track {
  constructor(det, t, opts) {
    const [x, y, w, h] = det.bbox, cx = x + w / 2, cy = y + h / 2;
    this.id = opts.idPrefix + (NEXT++);
    const q = opts.processNoise;
    this.kx = new KF1D(cx, { q: q * h, r: (0.05 * h) ** 2, p0: (0.1 * h) ** 2, pv0: (2 * h) ** 2 });
    this.ky = new KF1D(cy, { q: q * h, r: (0.05 * h) ** 2, p0: (0.1 * h) ** 2, pv0: (2 * h) ** 2 });
    this.kw = new KF1D(w, { q: 0.05 * q * h, r: (0.08 * w) ** 2, p0: (0.1 * w) ** 2, pv0: (0.5 * w) ** 2 });
    this.kh = new KF1D(h, { q: 0.05 * q * h, r: (0.08 * h) ** 2, p0: (0.1 * h) ** 2, pv0: (0.5 * h) ** 2 });
    this.t = t; this.firstSeen = t; this.lastSeen = t; this.hits = 1; this.state = 'tentative';
    this.score = det.score; this.emb = det.emb || null; this.det = det; this.history = [{ t, bbox: det.bbox.slice() }];
    this.pose = det.pose || null;
  }
  predict(t) { const dt = t - this.t; if (dt > 0) { for (const k of [this.kx, this.ky, this.kw, this.kh]) k.predict(dt); this.t = t; } }
  get bbox() { const w = Math.max(2, this.kw.pos), h = Math.max(4, this.kh.pos); return [this.kx.pos - w / 2, this.ky.pos - h / 2, w, h]; }
  get velocity() { return [this.kx.vel, this.ky.vel]; }
  /** Foot point (bottom centre of the box, or ankle midpoint when a pose is attached). */
  get foot() {
    const p = this.pose; if (p && this.poseT === this.lastSeen) {
      const L = p[27], R = p[28]; if (L && R && L.v > 0.5 && R.v > 0.5) return [(L.x + R.x) / 2, Math.max(L.y, R.y)];
    }
    const b = this.bbox; return [b[0] + b[2] / 2, b[1] + b[3]];
  }
  update(det, t, alpha) {
    const [x, y, w, h] = det.bbox;
    this.kx.update(x + w / 2); this.ky.update(y + h / 2); this.kw.update(w); this.kh.update(h);
    this.lastSeen = t; this.hits++; this.score = det.score; this.det = det;
    if (det.emb) this.emb = blendEmbedding(this.emb, det.emb, alpha);
    if (det.pose) { this.pose = det.pose; this.poseT = t; }
    this.history.push({ t, bbox: det.bbox.slice() }); if (this.history.length > 90) this.history.shift();
  }
}

export class PlayerTracker {
  constructor(opts = {}) {
    this.o = {
      highThresh: 0.5, lowThresh: 0.15, newTrackThresh: 0.55, minHits: 2, maxLostSec: 4.0,
      matchCost: 0.8, lowMatchIou: 0.3, appearanceWeight: 0.3, reidMaxApp: 0.35, processNoise: 2.0,
      emaAlpha: 0.12, idPrefix: 'T', ...opts,
    };
    this.tracks = []; this.removed = 0;
  }
  /** dets: [{bbox:[x,y,w,h], score, emb?, pose?}], t in seconds. Returns confirmed tracks updated or coasting. */
  update(dets, t) {
    const o = this.o;
    for (const tr of this.tracks) tr.predict(t);
    const high = dets.filter(d => d.score >= o.highThresh), low = dets.filter(d => d.score >= o.lowThresh && d.score < o.highThresh);
    const confirmed = this.tracks.filter(tr => tr.state === 'confirmed' || tr.state === 'lost');
    const tentative = this.tracks.filter(tr => tr.state === 'tentative');

    // Stage 1: confirmed + lost tracks vs high-score detections (IoU + appearance; lost tracks by distance + appearance)
    const cost1 = confirmed.map(tr => high.map(d => this.cost(tr, d, t)));
    const a1 = hungarian(cost1, o.matchCost);
    const usedHigh = new Set(), matched = new Set();
    a1.forEach((j, i) => { if (j >= 0) { confirmed[i].update(high[j], t, o.emaAlpha); confirmed[i].state = 'confirmed'; usedHigh.add(j); matched.add(confirmed[i]); } });

    // Stage 2 (ByteTrack): remaining *tracked* tracks vs low-score detections, IoU only (occluded players give low scores)
    const remTracked = confirmed.filter(tr => !matched.has(tr) && tr.state === 'confirmed');
    const cost2 = remTracked.map(tr => low.map(d => 1 - iou(tr.bbox, d.bbox)));
    hungarian(cost2, 1 - o.lowMatchIou).forEach((j, i) => { if (j >= 0) { remTracked[i].update(low[j], t, o.emaAlpha); matched.add(remTracked[i]); } });

    // Stage 3: tentative tracks vs remaining high detections
    const remHighIdx = high.map((_, j) => j).filter(j => !usedHigh.has(j));
    // IoU fails at low analysis rates (CPU-only laptops: ~1 fps) when players move between frames,
    // so tentative tracks also match by foot-point distance normalised by body height.
    const near = (a, b, dt) => { const d = Math.hypot(a[0] + a[2] / 2 - b[0] - b[2] / 2, a[1] + a[3] - b[1] - b[3]) / Math.max(a[3], b[3]); const g = 0.35 + 1.2 * Math.min(dt, 1.5); return d < g && Math.max(a[3], b[3]) / Math.min(a[3], b[3]) < 1.5 ? 0.69 * d / g : 1; };
    const cost3 = tentative.map(tr => remHighIdx.map(j => Math.min(1 - iou(tr.bbox, high[j].bbox), near(tr.bbox, high[j].bbox, t - tr.lastSeen))));
    hungarian(cost3, 0.7).forEach((k, i) => { if (k >= 0) { const j = remHighIdx[k]; tentative[i].update(high[j], t, o.emaAlpha); usedHigh.add(j); matched.add(tentative[i]); if (tentative[i].hits >= o.minHits) tentative[i].state = 'confirmed'; } });

    // Unmatched tracks
    for (const tr of this.tracks) {
      if (matched.has(tr)) continue;
      if (tr.state === 'tentative') tr.state = 'removed';
      else if (tr.state === 'confirmed') tr.state = 'lost';
      if (tr.state === 'lost' && t - tr.lastSeen > o.maxLostSec) tr.state = 'removed';
    }
    // New tracks
    high.forEach((d, j) => { if (!usedHigh.has(j) && d.score >= o.newTrackThresh) this.tracks.push(new Track(d, t, o)); });
    const before = this.tracks.length; this.tracks = this.tracks.filter(tr => tr.state !== 'removed'); this.removed += before - this.tracks.length;
    return this.active();
  }
  cost(tr, d, t) {
    const o = this.o, b = tr.bbox, app = appearanceDistance(tr.emb, d.emb), hasApp = !!(tr.emb && d.emb);
    if (tr.state === 'lost') {
      // re-identification: allow larger displacement, but require appearance similarity
      const dtLost = t - tr.lastSeen, h = Math.max(b[3], d.bbox[3]);
      const dist = Math.hypot(b[0] + b[2] / 2 - (d.bbox[0] + d.bbox[2] / 2), b[1] + b[3] - (d.bbox[1] + d.bbox[3])) / h;
      const gate = 0.6 + 1.2 * dtLost; // body-heights
      const sizeRatio = Math.max(b[3], d.bbox[3]) / Math.min(b[3], d.bbox[3]);
      if (dist > gate || sizeRatio > 1.6 || (hasApp && app > o.reidMaxApp)) return 1e6;
      return hasApp ? 0.5 * (dist / gate) + 0.5 * app / o.reidMaxApp * 0.8 : 0.6 + 0.2 * dist / gate;
    }
    const ov = iou(b, d.bbox);
    if (ov <= 0.05) return 1e6;
    return hasApp ? (1 - o.appearanceWeight) * (1 - ov) + o.appearanceWeight * app : 1 - ov;
  }
  active() { return this.tracks.filter(tr => tr.state === 'confirmed' && tr.lastSeen === tr.t); }
  all() { return this.tracks; }
}
