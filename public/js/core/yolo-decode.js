// YOLO (v8/11 Ultralytics export) output decoding + NMS. Output tensor [1, 4+C, N] (cx,cy,w,h + class scores).
export const COCO = { person: 0, sportsBall: 32 };

/** Letterbox geometry for a source image of w x h into a square `size` input. */
export function letterbox(w, h, size = 640) { const s = Math.min(size / w, size / h); return { s, nw: Math.round(w * s), nh: Math.round(h * s), px: Math.floor((size - Math.round(w * s)) / 2), py: Math.floor((size - Math.round(h * s)) / 2), size }; }

export function nms(boxes, iouThr = 0.5) {
  const out = []; boxes.sort((a, b) => b.score - a.score);
  const iou = (a, b) => { const x1 = Math.max(a.bbox[0], b.bbox[0]), y1 = Math.max(a.bbox[1], b.bbox[1]), x2 = Math.min(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]), y2 = Math.min(a.bbox[1] + a.bbox[3], b.bbox[1] + b.bbox[3]); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.bbox[2] * a.bbox[3] + b.bbox[2] * b.bbox[3] - i); };
  for (const b of boxes) if (out.every(o => o.cls !== b.cls || iou(o, b) < iouThr)) out.push(b);
  return out;
}

/** data: Float32Array of shape [1, 4+C, N]. lb: letterbox(). Returns [{cls, score, bbox:[x,y,w,h]}] in source px. */
export function decodeYolo(data, dims, lb, { classes = [COCO.person, COCO.sportsBall], minScore = { 0: 0.25, 32: 0.15 }, iouThr = 0.5 } = {}) {
  const [, C4, N] = dims, out = [];
  for (let i = 0; i < N; i++) for (const c of classes) {
    const sc = data[(4 + c) * N + i]; if (sc < (minScore[c] ?? 0.25)) continue;
    const cx = data[i], cy = data[N + i], w = data[2 * N + i], h = data[3 * N + i];
    out.push({ cls: c, score: sc, bbox: [(cx - w / 2 - lb.px) / lb.s, (cy - h / 2 - lb.py) / lb.s, w / lb.s, h / lb.s] });
  }
  if (C4 < 5) return [];
  return nms(out, iouThr);
}
