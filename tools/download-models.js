// Downloads the model weights COURTSIDE uses into public/models/. Run: npm run models
// - yolo11n.onnx  (Ultralytics YOLO11n, COCO 80 classes; AGPL-3.0 licence — check it fits your use)
// - pose_landmarker_lite.task / pose_landmarker_full.task (Google MediaPipe, Apache-2.0)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/models');
const MODELS = [
  ['yolo11n.onnx', 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx'],
  ['pose_landmarker_lite.task', 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'],
  ['pose_landmarker_full.task', 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'],
];
fs.mkdirSync(dir, { recursive: true });
for (const [name, url] of MODELS) {
  const f = path.join(dir, name);
  if (fs.existsSync(f) && fs.statSync(f).size > 1e5) { console.log('✓', name, '(already present)'); continue; }
  process.stdout.write(`↓ ${name} … `);
  const r = await fetch(url); if (!r.ok) { console.log('FAILED', r.status); process.exitCode = 1; continue; }
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); console.log((fs.statSync(f).size / 1e6).toFixed(1), 'MB');
}
