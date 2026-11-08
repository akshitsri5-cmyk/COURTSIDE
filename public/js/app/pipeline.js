// Per-camera analysis pipeline: frame grab (requestVideoFrameCallback) -> synchronised timestamp ->
// person/ball detection -> pose -> appearance embedding -> GameAnalyzer.processCameraFrame.
// Also feeds the evidence-clip ring buffer and the camera health monitor.
import { embed } from '../core/appearance.js';
import { findBallCandidates } from '../core/ball-tracking.js';
import { attachPoses } from '../core/game-analyzer.js';
import { iou } from '../core/player-tracking.js';
import { CameraHealthMonitor } from '../core/camera-health.js';
import { PoseEstimator } from './detectors.js';

export const ANALYSIS_WIDTH = 960;
export class CameraPipeline {
  constructor({ cam, analyzer, detector, timestamper, recorder, serverNow, opts }) {
    Object.assign(this, { cam, analyzer, detector, timestamper, recorder, serverNow, opts });
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.thumb = document.createElement('canvas'); this.thumb.width = 96; this.thumb.height = 54; this.tctx = this.thumb.getContext('2d', { willReadFrequently: true });
    this.clipCanvas = document.createElement('canvas');
    this.pose = new PoseEstimator(); this.health = new CameraHealthMonitor(); this.last = null; this.busy = false; this.lastRun = 0; this.frameN = 0;
    this.timings = {}; this.lumSeries = null; this.enabled = true;
    this.pose.load(opts.poseModel).catch(() => { });
    this.loop();
  }
  loop() {
    const v = this.cam.video;
    const cb = (now, meta) => { if (this.stopped) return; this.onFrame(now, meta); v.requestVideoFrameCallback(cb); };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(cb);
    else { const t = () => { if (this.stopped) return; this.onFrame(performance.now(), {}); setTimeout(t, 33); }; t(); }
  }
  stop() { this.stopped = true; }
  size() { const v = this.cam.video; if (!v.videoWidth) return null; const w = ANALYSIS_WIDTH, h = Math.round(w * v.videoHeight / v.videoWidth); return { w, h }; }
  grab() { const s = this.size(); if (!s) return null; if (this.canvas.width !== s.w || this.canvas.height !== s.h) { this.canvas.width = s.w; this.canvas.height = s.h; } this.ctx.drawImage(this.cam.video, 0, 0, s.w, s.h); return this.ctx.getImageData(0, 0, s.w, s.h); }
  async onFrame(now, meta) {
    const stamp = this.timestamper.stamp(this.cam.id, meta, now); const t = stamp.serverMs / 1000;
    this.health.noteFrame(now / 1000); this.stampMethod = stamp.method;
    if (this.lumSeries) { this.tctx.drawImage(this.cam.video, 0, 0, 96, 54); const d = this.tctx.getImageData(0, 0, 96, 54).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; this.lumSeries.push({ t: stamp.serverMs, y: s / (96 * 54) }); }
    if (!this.enabled || this.busy || !this.detector.kind || this.cam.paused) return;
    if (now - this.lastRun < 1000 / this.opts.fps) return;
    this.busy = true; this.lastRun = now;
    try {
      const T0 = performance.now(), img = this.grab(); if (!img) return;
      const det = await this.detector.detect(this.canvas); const T1 = performance.now();
      const poses = this.opts.pose ? this.pose.detect(this.canvas, now) : []; const T2 = performance.now();
      let persons = attachPoses(det.persons.filter(p => p.bbox[3] > 20), poses);
      if (this.opts.pose) { let n = 0; for (const p of persons) if (!p.pose && p.score > 0.4 && n++ < 8) p.pose = this.pose.detectCrop(this.canvas, p.bbox); }
      persons = persons.map(p => ({ ...p, emb: embed(img, p.bbox) }));
      // colour candidates around the predicted ball (fast motion blur) or a coarse full-frame scan
      const est = this.analyzer.camera(this.cam.id).ball.estimate();
      const win = est ? [est.u - 80 - est.r * 4, est.v - 80 - est.r * 4, est.u + 80 + est.r * 4, est.v + 80 + est.r * 4] : null;
      const balls = [...det.balls, ...findBallCandidates(img, { window: win, step: win ? 2 : 4, minR: 3, maxR: 40 })];
      const out = this.analyzer.processCameraFrame(this.cam.id, t, { persons, balls });
      this.last = { t, persons, balls, out, w: img.width, h: img.height, poses: poses.length };
      this.timings = { detect: T1 - T0, pose: T2 - T1, total: performance.now() - T0, detector: this.detector.kind };
      this.frameN++;
      if (this.frameN % 2 === 0) this.recordFrame(t);
      if (this.frameN % 10 === 0) { this.tctx.drawImage(this.canvas, 0, 0, 96, 54); const d = this.tctx.getImageData(0, 0, 96, 54).data, g = new Float32Array(96 * 54); for (let i = 0; i < g.length; i++) g[i] = d[4 * i] * 0.3 + d[4 * i + 1] * 0.59 + d[4 * i + 2] * 0.11; this.healthReport = this.health.check(now / 1000, g, 96, 54); this.lastThumb = g; }
    } catch (e) { this.error = e.message; console.warn('pipeline', this.cam.id, e); }
    finally { this.busy = false; }
  }
  recordFrame(t) {
    const c = this.clipCanvas, w = 480, h = Math.round(480 * this.canvas.height / this.canvas.width); if (c.width !== w) { c.width = w; c.height = h; }
    const x = c.getContext('2d'); x.drawImage(this.canvas, 0, 0, w, h);
    this.drawOverlay(x, w / this.canvas.width);
    c.toBlob(b => b && this.recorder.ring(this.cam.id, 14).push(t, b), 'image/jpeg', 0.6);
  }
  /** Draw tracking overlay (scaled from analysis px) on a 2-D context. */
  drawOverlay(x, s, { fusion = this.analyzer.fusion, showPose = true, showCourt = false } = {}) {
    const L = this.last; if (!L?.out) return;
    const calib = this.analyzer.camera(this.cam.id).calib;
    if (showCourt && calib) this.opts.drawCourt?.(x, calib.Hc2i, s);
    x.lineWidth = 2; x.font = 'bold 11px system-ui';
    // raw detections not (yet) part of a confirmed track: thin dashed boxes, so every detected person is visible
    x.setLineDash([5, 4]); x.lineWidth = 1.5; x.strokeStyle = 'rgba(199,255,74,.75)';
    for (const p of L.persons) if (!L.out.tracks.some(tr => iou(tr.bbox, p.bbox) > 0.3)) { const b = p.bbox; x.strokeRect(b[0] * s, b[1] * s, b[2] * s, b[3] * s); x.fillStyle = 'rgba(199,255,74,.85)'; x.fillText(Math.round(p.score * 100) + '%', b[0] * s + 3, b[1] * s - 4); }
    x.setLineDash([]); x.lineWidth = 2;
    for (const tr of L.out.tracks) {
      const g = fusion.byCameraTrack(this.cam.id, tr.id), b = tr.bbox, col = g?.team === 0 ? '#c7ff4a' : g?.team === 1 ? '#ff914d' : '#9fb3ab';
      x.strokeStyle = col; x.strokeRect(b[0] * s, b[1] * s, b[2] * s, b[3] * s);
      const label = (g ? g.label || g.id : tr.id) + (tr.pose ? '' : ' ·');
      x.fillStyle = col; x.fillRect(b[0] * s, b[1] * s - 15, x.measureText(label).width + 8, 15); x.fillStyle = '#0b1010'; x.fillText(label, b[0] * s + 4, b[1] * s - 4);
      if (showPose && tr.pose && tr.poseT === tr.lastSeen) { x.strokeStyle = 'rgba(140,200,255,.85)'; x.lineWidth = 1.5; for (const [a, c] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]]) { const p = tr.pose[a], q = tr.pose[c]; if (p.v > 0.5 && q.v > 0.5) { x.beginPath(); x.moveTo(p.x * s, p.y * s); x.lineTo(q.x * s, q.y * s); x.stroke(); } } x.lineWidth = 2; }
    }
    const bt = this.analyzer.camera(this.cam.id).ball, e = bt.estimate();
    if (e) { x.strokeStyle = e.state === 'tracking' ? '#ff914d' : 'rgba(255,145,77,.5)'; x.setLineDash(e.state === 'tracking' ? [] : [4, 3]); x.beginPath(); x.arc(e.u * s, e.v * s, Math.max(5, e.r * s * 1.3), 0, 7); x.stroke(); x.setLineDash([]);
      x.strokeStyle = 'rgba(255,145,77,.45)'; x.beginPath(); bt.history.slice(-20).forEach((h, i) => i ? x.lineTo(h.u * s, h.v * s) : x.moveTo(h.u * s, h.v * s)); x.stroke(); }
    if (calib) for (const r of calib.rims) { x.strokeStyle = '#ff7777'; x.beginPath(); x.ellipse(r.u * s, r.v * s, r.rx * s, Math.max(1, r.ry * s), 0, 0, 7); x.stroke(); }
  }
}
