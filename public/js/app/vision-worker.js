// Vision worker (classic worker: MediaPipe's loader needs importScripts). Runs person/ball detection
// (EfficientDet) and pose (PoseLandmarker, whole frame + per-player crops) OFF the main thread, so the
// dashboard stays responsive whatever the hardware. GPU delegate first (OffscreenCanvas WebGL), CPU fallback.
self.module = { exports: {} }; self.exports = self.module.exports;
importScripts('/vendor/tasks-vision/vision_bundle.cjs');
const { FilesetResolver, ObjectDetector, PoseLandmarker } = self.module.exports;
let fileset, od, plWhole, plCrop, dev = 'GPU', model = '';

async function make(Cls, opts) { try { return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: dev } }); } catch (e) { if (dev === 'GPU') { dev = 'CPU'; return Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); } throw e; } }
async function init({ detModel = 'efficientdet_lite2', poseModel = '/models/pose_landmarker_lite.task' }) {
  fileset = fileset || await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
  try { od?.close(); } catch { }
  od = await make(ObjectDetector, { baseOptions: { modelAssetPath: `/models/${detModel}.tflite` }, runningMode: 'IMAGE', scoreThreshold: 0.12, maxResults: 40, categoryAllowlist: ['person', 'sports ball'] });
  model = detModel;
  if (!plWhole) { plWhole = await make(PoseLandmarker, { baseOptions: { modelAssetPath: poseModel }, runningMode: 'IMAGE', numPoses: 10, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4 }); plCrop = await make(PoseLandmarker, { baseOptions: { modelAssetPath: poseModel }, runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4 }); }
  return `${detModel === 'efficientdet_lite2' ? 'EfficientDet-Lite2' : 'EfficientDet-Lite0'} + pose (${dev}, background worker)`;
}
const toPx = (lms, x0, y0, w, h) => lms.map(p => ({ x: x0 + p.x * w, y: y0 + p.y * h, v: p.visibility ?? 1 }));
function inside(pose, [x, y, w, h]) { let n = 0, k = 0; for (const i of [0, 11, 12, 23, 24, 25, 26, 27, 28]) { const q = pose[i]; if (!q || q.v < 0.5) continue; n++; if (q.x >= x - 0.1 * w && q.x <= x + 1.1 * w && q.y >= y - 0.1 * h && q.y <= y + 1.1 * h) k++; } return n >= 4 ? k / n : 0; }
function detect({ bmp, pose, maxCrops = 4 }) {
  const t0 = performance.now(), W = bmp.width, H = bmp.height;
  const dets = (od.detect(bmp).detections || []).map(d => { const c = d.categories[0], b = d.boundingBox; return { person: c.categoryName === 'person', score: c.score, bbox: [b.originX, b.originY, b.width, b.height] }; });
  const persons = dets.filter(d => d.person && d.bbox[3] > 20).map(d => ({ bbox: d.bbox, score: d.score, pose: null }));
  const balls = dets.filter(d => !d.person).map(d => ({ x: d.bbox[0] + d.bbox[2] / 2, y: d.bbox[1] + d.bbox[3] / 2, r: (d.bbox[2] + d.bbox[3]) / 4, score: d.score, source: 'model' }));
  const t1 = performance.now();
  if (pose) {
    const whole = (plWhole.detect(bmp).landmarks || []).map(l => toPx(l, 0, 0, W, H)), used = new Set();
    for (const p of persons) { let best = -1, bs = 0.7; whole.forEach((q, j) => { if (used.has(j)) return; const s = inside(q, p.bbox); if (s > bs) { bs = s; best = j; } }); if (best >= 0) { p.pose = whole[best]; used.add(best); } }
    let n = 0; const oc = new OffscreenCanvas(8, 8), cx = oc.getContext('2d');
    for (const p of persons) { // top-down crops for players the whole-frame pass missed
      if (p.pose || p.score < 0.4 || n++ >= maxCrops) continue;
      const [x, y, w, h] = p.bbox, x0 = Math.max(0, x - 0.15 * w), y0 = Math.max(0, y - 0.09 * h), x1 = Math.min(W, x + 1.15 * w), y1 = Math.min(H, y + 1.09 * h), cw = x1 - x0, ch = y1 - y0;
      if (cw < 16 || ch < 32) continue; const sc = Math.max(1, 256 / ch); oc.width = Math.round(cw * sc); oc.height = Math.round(ch * sc); cx.drawImage(bmp, x0, y0, cw, ch, 0, 0, oc.width, oc.height);
      const l = plCrop.detect(oc).landmarks?.[0]; if (l) p.pose = toPx(l, x0, y0, cw, ch);
    }
  }
  bmp.close();
  return { persons, balls, detectMs: t1 - t0, poseMs: performance.now() - t1, model };
}
self.onmessage = async e => {
  const { id, cmd } = e.data;
  try { const result = cmd === 'init' ? await init(e.data) : detect(e.data); self.postMessage({ id, ok: true, result }); }
  catch (err) { self.postMessage({ id, ok: false, error: String(err?.message || err) }); }
};
