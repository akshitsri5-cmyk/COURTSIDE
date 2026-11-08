// Appearance embeddings for re-identification: HSV colour histograms of the jersey (upper torso)
// and shorts (lower torso) regions. Cheap, illumination-tolerant (hue/sat weighted) and works across
// cameras for uniform colours. A learned ReID network (e.g. OSNet) can replace `embed` later; the
// tracker only depends on `appearanceDistance`.

const HB = 12, SB = 4, VB = 4, BINS = HB * SB + VB; // chromatic bins + achromatic (gray/white/black) bins

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx / 255];
}

function histRegion(img, x0, y0, x1, y1, step) {
  const hist = new Float32Array(BINS); let n = 0;
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(img.width, Math.ceil(x1)); y1 = Math.min(img.height, Math.ceil(y1));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4, [h, s, v] = rgb2hsv(img.data[i], img.data[i + 1], img.data[i + 2]);
    if (s > 0.22 && v > 0.15) { // soft (linear) hue binning: similar colours never fall into disjoint bins
      const fh = h / 360 * HB - 0.5, b0 = Math.floor(fh), w1 = fh - b0, sb = Math.min(SB - 1, Math.floor(s * SB));
      hist[((b0 + HB) % HB) * SB + sb] += 1 - w1; hist[((b0 + 1) % HB) * SB + sb] += w1;
    }
    else hist[HB * SB + Math.min(VB - 1, Math.floor(v * VB))] += 1;
    n++;
  }
  if (n) for (let i = 0; i < BINS; i++) hist[i] /= n;
  return hist;
}

/** Embed a person crop. bbox = [x,y,w,h] in image px. Returns {jersey, shorts} histograms or null. */
export function embed(img, [x, y, w, h]) {
  if (w < 6 || h < 12) return null;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 24));
  // central 60 % horizontally avoids background at box edges
  const cx0 = x + w * 0.2, cx1 = x + w * 0.8;
  return { jersey: histRegion(img, cx0, y + h * 0.18, cx1, y + h * 0.45, step), shorts: histRegion(img, cx0, y + h * 0.45, cx1, y + h * 0.62, step) };
}

function bhattacharyya(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]); return Math.min(1, s); }

/** Distance in [0,1]; 0 = identical colour distribution. */
export function appearanceDistance(e1, e2) {
  if (!e1 || !e2) return 0.5; // unknown: neutral
  return 1 - (0.7 * bhattacharyya(e1.jersey, e2.jersey) + 0.3 * bhattacharyya(e1.shorts, e2.shorts));
}

/** Exponential moving average of embeddings (track gallery). */
export function blendEmbedding(old, nw, alpha = 0.15) {
  if (!old) return nw; if (!nw) return old;
  const mix = (a, b) => a.map((v, i) => (1 - alpha) * v + alpha * b[i]);
  return { jersey: Float32Array.from(mix(old.jersey, nw.jersey)), shorts: Float32Array.from(mix(old.shorts, nw.shorts)) };
}

/** Team clustering: 2-means on jersey histograms. Returns labels (0/1) per embedding (null -> -1). */
export function clusterTeams(embs, iters = 12) {
  const valid = embs.map((e, i) => e ? i : -1).filter(i => i >= 0);
  if (valid.length < 2) return { labels: embs.map(e => e ? 0 : -1), separation: 0 };
  // init: farthest pair
  let a = valid[0], b = valid[1], bd = -1;
  for (const i of valid) for (const j of valid) { const d = appearanceDistance(embs[i], embs[j]); if (d > bd) { bd = d; a = i; b = j; } }
  let c = [embs[a].jersey, embs[b].jersey];
  let labels = embs.map(() => -1);
  for (let it = 0; it < iters; it++) {
    labels = embs.map(e => { if (!e) return -1; const d0 = 1 - bhattacharyya(e.jersey, c[0]), d1 = 1 - bhattacharyya(e.jersey, c[1]); return d0 <= d1 ? 0 : 1; });
    c = [0, 1].map(k => { const m = new Float32Array(BINS); let n = 0; embs.forEach((e, i) => { if (labels[i] === k) { n++; for (let q = 0; q < BINS; q++) m[q] += e.jersey[q]; } }); if (n) for (let q = 0; q < BINS; q++) m[q] /= n; return n ? m : c[k]; });
  }
  return { labels, separation: 1 - bhattacharyya(c[0], c[1]) };
}
