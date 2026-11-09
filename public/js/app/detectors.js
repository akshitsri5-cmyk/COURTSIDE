// Browser detectors. Nothing here fabricates detections: if a model fails to load, the UI says so and
// that stage simply produces no output.
//  * PersonBallDetector: YOLO11n (ONNX Runtime Web, WebGPU -> WASM) with COCO-SSD (TF.js) fallback.
//  * PoseEstimator: MediaPipe PoseLandmarker (multi-person, 33 landmarks), one instance per camera.
import { letterbox, decodeYolo, COCO } from '../core/yolo-decode.js';

export class PersonBallDetector {
  constructor() { this.kind = null; this.status = 'not loaded'; this.session = null; this.coco = null; this.busy = false; this.inputSize = 640; this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = 640; }
  /** pref: 'auto'/'effdet' (MediaPipe EfficientDet-Lite2, GPU), 'coco' (COCO-SSD, TF.js WebGL), 'yolo' (YOLO11n on CPU/WASM, verified) or 'yolo-gpu' (YOLO11n on WebGPU, EXPERIMENTAL: produced broken boxes on a real GPU). */
  async load(pref = 'auto') {
    if (this.kind) return this.kind;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
      const coco = async why => {
        await loadScript('/vendor/tfjs/tf.min.js'); await loadScript('/vendor/coco-ssd/coco-ssd.min.js');
        await window.tf.ready(); this.coco = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
        this.kind = 'COCO-SSD'; this.status = `COCO-SSD (${window.tf.getBackend()}${why ? '; ' + why : ''})`; return this.kind;
      };
      // default: Google MediaPipe EfficientDet-Lite2 on the GPU (same runtime as the pose model, robust on laptops)
      if (pref === 'auto' || pref === 'effdet') {
        try {
          visionMod = visionMod || await import('/vendor/tasks-vision/vision_bundle.mjs');
          fileset = fileset || await visionMod.FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
          const o = d => ({ baseOptions: { modelAssetPath: '/models/efficientdet_lite2.tflite', delegate: d }, runningMode: 'IMAGE', scoreThreshold: 0.12, maxResults: 40, categoryAllowlist: ['person', 'sports ball'] });
          let dev = 'GPU'; try { this.effdet = await visionMod.ObjectDetector.createFromOptions(fileset, o('GPU')); } catch { dev = 'CPU'; this.effdet = await visionMod.ObjectDetector.createFromOptions(fileset, o('CPU')); }
          this.kind = 'EfficientDet'; this.status = `EfficientDet-Lite2 (${dev})`; return this.kind;
        } catch (e) { console.warn('EfficientDet unavailable:', e.message); if (pref === 'effdet') { this.status = 'NO DETECTOR: ' + e.message; this.loading = null; throw e; } }
      }
      if (pref === 'coco' || pref === 'auto') {
        try { return await coco(''); }
        catch (e) { console.warn('COCO-SSD unavailable:', e.message); if (pref === 'coco') { this.status = 'NO DETECTOR: ' + e.message; this.loading = null; throw e; } }
      }
      try {
        const head = await fetch('/models/yolo11n.onnx', { method: 'HEAD' });
        if (!head.ok) throw new Error('models/yolo11n.onnx missing (run npm run models)');
        const ort = await import('/vendor/ort/ort.all.bundle.min.mjs');
        ort.env.wasm.wasmPaths = '/vendor/ort/'; ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        this.ort = ort;
        const eps = pref === 'yolo-gpu' && gpu ? ['webgpu', 'wasm'] : ['wasm'];
        let lastErr;
        for (const ep of eps) { ort.env.wasm.proxy = ep === 'wasm'; /* CPU inference in a worker keeps the UI responsive (proxy is WASM-only) */ try { this.session = await ort.InferenceSession.create('/models/yolo11n.onnx', { executionProviders: [ep], graphOptimizationLevel: 'all' }); this.ep = ep; break; } catch (e) { lastErr = e instanceof Error ? e : new Error(String(e)); console.warn('ORT', ep, e); } }
        if (!this.session) throw lastErr;
        this.kind = 'YOLO11n'; this.status = `YOLO11n (${this.ep})`; return this.kind;
      } catch (e) {
        console.warn('YOLO unavailable:', e.message);
        try { if (this.coco) throw new Error('COCO-SSD also failed'); return await coco('fallback, YOLO: ' + e.message); }
        catch (e2) { this.status = 'NO DETECTOR: ' + e2.message; this.kind = null; this.loading = null; throw e2; }
      }
    })();
    return this.loading;
  }
  async switchTo(pref) { await this.queue; try { this.effdet?.close(); } catch { } this.effdet = null; this.session = null; this.coco = null; this.kind = null; this.loading = null; return this.load(pref); }
  /** Serialised: one inference at a time across all camera pipelines (shared session). */
  detect(source) { const run = () => this._detect(source); this.queue = (this.queue || Promise.resolve()).then(run, run); return this.queue; }
  /** source: canvas. Returns {persons:[{bbox,score}], balls:[{x,y,r,score,source:'model'}], ms}. */
  async _detect(source) {
    const t0 = performance.now(), w = source.width, h = source.height;
    let dets = [];
    if (this.effdet) {
      dets = (this.effdet.detect(source).detections || []).map(d => { const c = d.categories[0], b = d.boundingBox; return { cls: c.categoryName === 'person' ? COCO.person : COCO.sportsBall, score: c.score, bbox: [b.originX, b.originY, b.width, b.height] }; });
    } else if (this.session) {
      const S = this.inputSize, lb = letterbox(w, h, S), c = this.canvas.getContext('2d', { willReadFrequently: true });
      c.fillStyle = 'rgb(114,114,114)'; c.fillRect(0, 0, S, S); c.drawImage(source, lb.px, lb.py, lb.nw, lb.nh);
      const px = c.getImageData(0, 0, S, S).data, n = S * S, f = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) { f[i] = px[4 * i] / 255; f[n + i] = px[4 * i + 1] / 255; f[2 * n + i] = px[4 * i + 2] / 255; }
      const input = new this.ort.Tensor('float32', f, [1, 3, S, S]);
      const out = await this.session.run({ [this.session.inputNames[0]]: input }), o = out[this.session.outputNames[0]];
      dets = decodeYolo(o.data, o.dims, lb);
    } else if (this.coco) {
      dets = (await this.coco.detect(source, 40, 0.15)).filter(p => p.class === 'person' || p.class === 'sports ball').map(p => ({ cls: p.class === 'person' ? COCO.person : COCO.sportsBall, score: p.score, bbox: p.bbox }));
    }
    return {
      persons: dets.filter(d => d.cls === COCO.person).map(d => ({ bbox: d.bbox, score: d.score })),
      balls: dets.filter(d => d.cls === COCO.sportsBall).map(d => ({ x: d.bbox[0] + d.bbox[2] / 2, y: d.bbox[1] + d.bbox[3] / 2, r: (d.bbox[2] + d.bbox[3]) / 4, score: d.score, source: 'model' })),
      ms: performance.now() - t0,
    };
  }
}

let visionMod = null, fileset = null;
export class PoseEstimator {
  constructor() { this.lm = null; this.status = 'not loaded'; this.lastTs = 0; }
  async load(model = '/models/pose_landmarker_lite.task') {
    if (this.lm) return; if (this.loading) return this.loading;
    this.loading = (async () => {
      visionMod = visionMod || await import('/vendor/tasks-vision/vision_bundle.mjs');
      fileset = fileset || await visionMod.FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
      const opts = d => ({ baseOptions: { modelAssetPath: model, delegate: d }, runningMode: 'VIDEO', numPoses: 10, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4 });
      let dev = 'GPU';
      try { this.lm = await visionMod.PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { dev = 'CPU'; this.lm = await visionMod.PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
      // top-down fallback for people the whole-frame pass missed (small / overlapping players)
      this.crop = await visionMod.PoseLandmarker.createFromOptions(fileset, { ...opts(dev), runningMode: 'IMAGE', numPoses: 1 });
      this.status = `MediaPipe Pose (${dev}, multi-person + per-player crops)`;
    })().catch(e => { this.status = 'pose unavailable: ' + e.message; this.loading = null; throw e; });
    return this.loading;
  }
  /** Pose for one person box (top-down). Returns 33 {x,y,v} in source px or null. */
  detectCrop(source, [x, y, w, h], maxCrops = 1) {
    if (!this.crop) return null;
    const pad = 0.15, x0 = Math.max(0, x - w * pad), y0 = Math.max(0, y - h * pad * 0.6), x1 = Math.min(source.width, x + w * (1 + pad)), y1 = Math.min(source.height, y + h * (1 + pad * 0.6));
    const cw = x1 - x0, ch = y1 - y0; if (cw < 16 || ch < 32) return null;
    const sc = Math.max(1, 256 / ch); const c = this.cropCanvas || (this.cropCanvas = document.createElement('canvas'));
    c.width = Math.round(cw * sc); c.height = Math.round(ch * sc); c.getContext('2d').drawImage(source, x0, y0, cw, ch, 0, 0, c.width, c.height);
    const r = this.crop.detect(c); const l = r.landmarks?.[0]; if (!l) return null;
    return l.map(p => ({ x: x0 + p.x * cw, y: y0 + p.y * ch, v: p.visibility ?? 1 }));
  }
  /** Returns array of poses, each 33 {x,y,v} in source pixels. */
  detect(source, tsMs) {
    if (!this.lm) return [];
    const ts = Math.max(this.lastTs + 1, Math.round(tsMs)); this.lastTs = ts;
    const r = this.lm.detectForVideo(source, ts), W = source.width, H = source.height;
    return (r.landmarks || []).map(lms => lms.map(p => ({ x: p.x * W, y: p.y * H, v: p.visibility ?? 1 })));
  }
}

export function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.append(s); }); }

/**
 * Default detector: EfficientDet + pose in a background worker (see vision-worker.js). Same interface as
 * PersonBallDetector, plus `withPose` (persons already carry their pose) — the main thread only draws.
 */
export class WorkerVision {
  constructor() { this.kind = null; this.status = 'not loaded'; this.withPose = true; this.pending = new Map(); this.seq = 0; }
  call(msg, transfer = []) { return new Promise((res, rej) => { const id = ++this.seq; this.pending.set(id, { res, rej }); this.w.postMessage({ ...msg, id }, transfer); }); }
  async load(model = 'efficientdet_lite2') {
    if (this.kind && this.model === model) return this.kind;
    if (!this.w) { this.w = new Worker('/js/app/vision-worker.js'); this.w.onmessage = e => { const p = this.pending.get(e.data.id); this.pending.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); }; }
    this.status = 'loading model…'; this.status = await this.call({ cmd: 'init', detModel: model }); this.model = model; this.kind = 'EfficientDet'; return this.kind;
  }
  switchTo(model) { this.kind = null; return this.queue = (this.queue || Promise.resolve()).then(() => this.load(model)); }
  /** source: canvas. One request at a time across all cameras (the worker is single-threaded anyway). */
  detect(source, { pose = true } = {}) {
    const run = async () => { const t0 = performance.now(); const bmp = await createImageBitmap(source); const r = await this.call({ cmd: 'detect', bmp, pose }, [bmp]); return { ...r, ms: performance.now() - t0 }; };
    this.queue = (this.queue || Promise.resolve()).then(run, run); return this.queue;
  }
}
