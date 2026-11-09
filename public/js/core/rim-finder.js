// Automatic rim finder (no clicks). The COCO-trained detectors have no "hoop" class, so this finds the rim by
// what makes it recognisable: a thin ORANGE-RED ring seen as a flat ellipse (cameras are below rim height), high in
// the picture, with a BRIGHT BACKBOARD above it and NET texture below it — and it must stay in the same place over
// several looks (a moving ball, a cone or a red shirt does not). Black/white/grey rims are not found: use 🏀 Mark rim.

function hsv(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } return [h, mx ? d / mx : 0, mx / 255]; }

/** img: {width,height,data RGBA}. Returns candidates [{u,v,rx,ry,score}] in image px, best first. */
export function findRimCandidates(img, { maxDim = 480 } = {}) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height)), w = Math.round(img.width * s), h = Math.round(img.height * s);
  const mask = new Uint8Array(w * h), lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    lum[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b; const [H, S, V] = hsv(r, g, b);
    if ((H <= 28 || H >= 340) && S >= 0.45 && V >= 0.3) mask[y * w + x] = 1;
  }
  const lab = new Int32Array(w * h), out = [], st = [];
  for (let i = 0, L = 0; i < mask.length; i++) {
    if (!mask[i] || lab[i]) continue; L++; lab[i] = L; st.push(i); let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    while (st.length) { const k = st.pop(), x = k % w, y = (k / w) | 0; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (mask[j] && !lab[j]) { lab[j] = L; st.push(j); } } }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = n / (bw * bh), aspect = bw / bh;
    if (bw < 8 || bw > w * 0.4 || aspect < 1.8 || fill > 0.75 || y0 > h * 0.75) continue; // a thin, wide ring high-ish in the picture
    // backboard above (bright, uniform-ish) and net below (textured) vs. beside
    const box = (ax, ay, aw, ah) => { let sum = 0, sq = 0, ed = 0, c = 0; for (let y = Math.max(1, Math.round(ay)); y < Math.min(h - 1, ay + ah); y++) for (let x = Math.max(1, Math.round(ax)); x < Math.min(w - 1, ax + aw); x++) { const v = lum[y * w + x]; sum += v; sq += v * v; ed += Math.abs(v - lum[y * w + x + 1]) + Math.abs(v - lum[(y + 1) * w + x]); c++; } return c ? { m: sum / c, sd: Math.sqrt(Math.max(0, sq / c - (sum / c) ** 2)), e: ed / c } : null; };
    const above = box(x0 - bw * 0.3, y0 - bw * 1.1, bw * 1.6, bw * 1.0), net = box(x0 + bw * 0.15, y1 + 1, bw * 0.7, bw * 0.8), side = box(x1 + bw * 0.3, y1 + 1, bw * 0.7, bw * 0.8), side2 = box(x0 - bw, y1 + 1, bw * 0.7, bw * 0.8);
    if (!above || !net) continue;
    const sides = [side, side2].filter(Boolean), sideE = sides.length ? Math.min(...sides.map(q => q.e)) : 10;
    const board = Math.max(0, Math.min(1, (above.m - 110) / 90)), netTex = Math.max(0, Math.min(1, (net.e - sideE) / 12));
    const ring = Math.max(0, Math.min(1, (0.75 - fill) / 0.5)) * Math.min(1, (aspect - 1.8) / 2), high = 1 - y0 / h;
    const score = 0.3 * ring + 0.3 * board + 0.25 * netTex + 0.15 * high;
    out.push({ u: (x0 + bw / 2) / s, v: ((y0 + y1) / 2) / s, rx: bw / 2 / s, ry: Math.max(1, bh / 2 / s), score, parts: { ring, board, netTex, high } });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Accumulates looks over time; reports a rim once the same candidate wins repeatedly (static object). */
export class RimFinder {
  constructor({ need = 3, of = 5, minScore = 0.45 } = {}) { this.o = { need, of, minScore }; this.looks = []; }
  look(img) {
    const c = findRimCandidates(img).filter(c => c.score >= this.o.minScore)[0] || null;
    this.looks.push(c); if (this.looks.length > this.o.of) this.looks.shift();
    if (!c) return null;
    const same = this.looks.filter(q => q && Math.hypot(q.u - c.u, q.v - c.v) < Math.max(6, c.rx * 0.5) && Math.abs(q.rx - c.rx) < c.rx * 0.35);
    if (same.length < this.o.need) return null;
    const med = k => same.map(q => q[k]).sort((a, b) => a - b)[same.length >> 1];
    return { side: 1, u: med('u'), v: med('v'), rx: med('rx'), ry: Math.max(2, med('ry')), score: med('score'), source: 'auto' };
  }
}
