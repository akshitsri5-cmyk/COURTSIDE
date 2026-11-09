// Automatic court-line detection and model fitting (pure JS, no OpenCV needed in the browser).
//  1. lineMask(): thin bright ridge filter (court paint is a thin line brighter than the floor on both sides)
//  2. distanceTransform(): chamfer distance to the nearest line pixel (+ nearest-pixel index)
//  3. houghLines(): progressive Hough transform for straight segments
//  4. autoDetectCourt(): hypothesise court->image homographies from line intersections and score them
//     against ALL court markings (incl. arcs), then refine with an ICP-style loop.
//  5. refineHomography(): refine a manual 4-point calibration against detected line pixels.
//  6. markingSupport(): per-marking evidence (boundary, 3pt, FT line, key, centre) for the dashboard.
import { estimateHomography, applyH, hDepth, cameraFromHomography } from './homography.js';
import { CourtModel } from './court-model.js';

/** Downscale RGBA image to grayscale Float32 with max dimension `maxDim`. Returns {w,h,gray,scale}. */
export function toGray(img, maxDim = 480) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s)), gray = new Float32Array(w * h);
  const sat = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // box-average source pixels for anti-aliasing
    const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s)), y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) { const i = (yy * img.width + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    r /= n; g /= n; b /= n; gray[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat[y * w + x] = mx > 0 ? (mx - mn) / mx : 0;
  }
  return { w, h, gray, sat, scale: s };
}

/** Thin bright-line mask. tau = expected max half-width of a line in px, contrast = min brightness gap. */
export function lineMask({ w, h, gray, sat }, { tau = 4, contrast = 18, maxSat = 0.45 } = {}) {
  const m = new Uint8Array(w * h);
  for (let y = tau; y < h - tau; y++) for (let x = tau; x < w - tau; x++) {
    const i = y * w + x, g = gray[i];
    if (sat && sat[i] > maxSat) continue; // court paint is usually white/low saturation
    const horiz = g - gray[i - tau] > contrast && g - gray[i + tau] > contrast;
    const vert = g - gray[i - tau * w] > contrast && g - gray[i + tau * w] > contrast;
    if (horiz || vert) m[i] = 1;
  }
  return m;
}

/** Two-pass chamfer (3-4) distance transform. Returns Float32Array of distances in px (approx Euclidean). */
export function distanceTransform(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Progressive Hough transform. Returns lines [{theta, rho, votes, a, b, c}] where a*x + b*y = c (normalised). */
export function houghLines(mask, w, h, { maxLines = 16, thetaBins = 180, minVotes = null, support = 2 } = {}) {
  const diag = Math.ceil(Math.hypot(w, h)), nR = 2 * diag + 1, acc = new Int32Array(thetaBins * nR);
  const cos = new Float32Array(thetaBins), sin = new Float32Array(thetaBins);
  for (let t = 0; t < thetaBins; t++) { cos[t] = Math.cos(t * Math.PI / thetaBins); sin[t] = Math.sin(t * Math.PI / thetaBins); }
  const pts = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) pts.push(x, y);
  const alive = new Uint8Array(pts.length / 2).fill(1);
  const vote = (k, dv) => { const x = pts[2 * k], y = pts[2 * k + 1]; for (let t = 0; t < thetaBins; t++) acc[t * nR + Math.round(x * cos[t] + y * sin[t]) + diag] += dv; };
  for (let k = 0; k < alive.length; k++) vote(k, 1);
  const minV = minVotes ?? Math.max(20, Math.round(0.08 * Math.max(w, h)));
  const lines = [];
  for (let it = 0; it < maxLines; it++) {
    let best = -1, bv = 0; for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; best = i; }
    if (bv < minV) break;
    const t = Math.floor(best / nR), rho = (best % nR) - diag, theta = t * Math.PI / thetaBins;
    const a = cos[t], b = sin[t];
    // refine with least squares on supporting pixels (total least squares)
    let sx = 0, sy = 0, n = 0; const sup = [];
    for (let k = 0; k < alive.length; k++) { if (!alive[k]) continue; const x = pts[2 * k], y = pts[2 * k + 1]; if (Math.abs(a * x + b * y - rho) <= support) { sup.push(k); sx += x; sy += y; n++; } }
    for (const k of sup) { alive[k] = 0; vote(k, -1); }
    if (n < minV) continue;
    const mx = sx / n, my = sy / n; let cxx = 0, cyy = 0, cxy = 0;
    for (const k of sup) { const dx = pts[2 * k] - mx, dy = pts[2 * k + 1] - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy); // direction of the line
    const na = -Math.sin(ang), nb = Math.cos(ang);
    const L = { theta, rho, votes: n, a: na, b: nb, c: na * mx + nb * my, dir: ang, mid: [mx, my] };
    // merge near-duplicates (the same painted line found twice, e.g. both edges of a thick line)
    if (lines.some(o => angDiff(o.dir, L.dir) < 2 * Math.PI / 180 && Math.abs(o.a * mx + o.b * my - o.c) < 4)) continue;
    lines.push(L);
  }
  return lines;
}

function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b; if (Math.abs(det) < 1e-6) return null;
  return [(l1.c * l2.b - l2.c * l1.b) / det, (l1.a * l2.c - l2.a * l1.c) / det];
}
function angDiff(a, b) { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }

/**
 * Split lines into two families of world-parallel lines by vanishing point (RANSAC over line pairs).
 * Lines parallel on the court converge to a common vanishing point in the image; this works for
 * strongly oblique (corner) views where plain angle clustering fails.
 */
export function lineFamilies(lines, { angTol = 2.5 * Math.PI / 180 } = {}) {
  if (lines.length < 4) return [lines, []];
  const consistent = (l, vp) => {
    let dx, dy;
    if (vp.inf) { dx = vp.dx; dy = vp.dy; } else { dx = vp.p[0] - l.mid[0]; dy = vp.p[1] - l.mid[1]; }
    return angDiff(Math.atan2(dy, dx), l.dir) < angTol;
  };
  const vpOf = (a, b) => { const p = intersect(a, b); if (!p || Math.hypot(p[0] - a.mid[0], p[1] - a.mid[1]) > 1e5) { return { inf: true, dx: Math.cos(a.dir), dy: Math.sin(a.dir) }; } return { p }; };
  const bestFamily = L => {
    let best = []; let bestW = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const vp = vpOf(L[i], L[j]); const fam = L.filter(l => consistent(l, vp)); const wsum = fam.reduce((s, l) => s + l.votes, 0);
      if (fam.length > best.length || (fam.length === best.length && wsum > bestW)) { best = fam; bestW = wsum; }
    }
    return best;
  };
  const A = bestFamily(lines);
  // Second family = all remaining lines: curved markings produce spurious chords, so we do not demand a
  // second exact vanishing point here; the model-based scoring rejects wrong combinations.
  return [A, lines.filter(l => !A.includes(l))];
}

/** Project model samples into the (downscaled) image; keep samples at >= minSpacing px apart. */
function projectSamples(H, samples, w, h, minSpacing = 0) {
  const out = []; let last = null;
  for (const s of samples) {
    if (s.break) { last = null; continue; }
    if (hDepth(H, s.p) <= 0) { last = null; continue; }
    const [u, v] = applyH(H, s.p);
    if (!(u >= 0 && v >= 0 && u < w && v < h)) { last = null; continue; }
    if (minSpacing && last && Math.hypot(u - last[0], v - last[1]) < minSpacing) continue;
    out.push({ u, v, p: s.p, name: s.name, group: s.group }); last = [u, v];
  }
  return out;
}
function sampleModel(model, step) {
  const out = []; for (const m of model.markings(step)) { for (const p of m.pts) out.push({ p, name: m.name, group: m.group }); out.push({ break: true }); } return out;
}

/**
 * Local conditioning of a court->image homography at court point p: ratio of the singular values of the
 * 2x2 Jacobian. Perspective foreshortening rarely exceeds ~15:1; collapsed (degenerate) fits have huge ratios.
 */
export function jacobianRatio(H, p) {
  const e = 0.5, a = applyH(H, p), bx = applyH(H, [p[0] + e, p[1]]), by = applyH(H, [p[0], p[1] + e]);
  const j11 = (bx[0] - a[0]) / e, j21 = (bx[1] - a[1]) / e, j12 = (by[0] - a[0]) / e, j22 = (by[1] - a[1]) / e;
  const T = j11 * j11 + j12 * j12 + j21 * j21 + j22 * j22, D = Math.abs(j11 * j22 - j12 * j21);
  const s1 = Math.sqrt((T + Math.sqrt(Math.max(0, T * T - 4 * D * D))) / 2), s2 = D / (s1 || 1);
  return s2 > 1e-12 ? s1 / s2 : Infinity;
}
/** Reject homographies that are numerically degenerate somewhere in the visible part of the court. */
export function isPlausible(H, w, h, maxRatio = 25) {
  let n = 0;
  for (const p of [[0, 0], [7, 0], [-7, 0], [10, 4], [10, -4], [-10, 4], [-10, -4], [3, 5], [3, -5]]) {
    if (hDepth(H, p) <= 0) continue; const q = applyH(H, p); if (!(q[0] >= 0 && q[1] >= 0 && q[0] < w && q[1] < h)) continue;
    n++; if (jacobianRatio(H, p) > maxRatio) return false;
  }
  return true;
}

/** Score a hypothesis: matched coverage (distinct cells) minus a penalty for visible-but-unmatched samples. */
export function scoreHomography(H, dt, w, h, samples, { tol = 2.5, minSpacing = 4, cell = 4 } = {}) {
  const proj = projectSamples(H, samples, w, h, minSpacing);
  const hit = new Set(), seen = new Set();
  for (const s of proj) {
    const key = Math.floor(s.u / cell) * 100003 + Math.floor(s.v / cell);
    seen.add(key); if (dt[Math.round(s.v) * w + Math.round(s.u)] < tol) hit.add(key);
  }
  const matched = hit.size, visible = seen.size;
  return { score: matched - 0.5 * (visible - matched), matched, visible, fraction: visible ? matched / visible : 0 };
}

/** ICP-style refinement of a court->image homography (in downscaled image px) against the line mask. */
export function refineWithMask(H0, mask, dt, w, h, model, { iterations = 12, radii = [16, 10, 6, 4, 3] } = {}) {
  const samples = sampleModel(model, 0.15); let H = H0;
  // nearest line pixel search in a local window (aperture-aware: search along the local model normal)
  for (let it = 0; it < iterations; it++) {
    const r = radii[Math.min(it, radii.length - 1)];
    const proj = projectSamples(H, samples, w, h, 3), src = [], dst = [], err = [];
    for (let i = 0; i < proj.length; i++) {
      const s = proj[i]; const prev = proj[i - 1] || proj[i + 1]; if (!prev) continue;
      let tx = s.u - prev.u, ty = s.v - prev.v; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl; const nx = -ty, ny = tx;
      const on = k => { const x = Math.round(s.u + nx * k), y = Math.round(s.v + ny * k); return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]; };
      let kk = null;
      for (let k = 0; k <= r && kk === null; k++) { if (on(k)) kk = k; else if (on(-k)) kk = -k; }
      let best = null, bd = Infinity;
      if (kk !== null) { // snap to the CENTRE of the painted line (mask run along the normal), not its near edge
        let lo = kk, hi = kk; while (lo - 1 >= kk - 12 && on(lo - 1)) lo--; while (hi + 1 <= kk + 12 && on(hi + 1)) hi++;
        const k = (lo + hi) / 2; bd = Math.abs(k); best = [s.u + nx * k, s.v + ny * k];
      }
      if (best) { src.push(s.p); dst.push(best); err.push(bd); }
    }
    if (src.length < 8) break;
    // trim the worst 20 % (players occluding lines, other floor markings)
    const order = err.map((e, i) => [e, i]).sort((a, b) => a[0] - b[0]).slice(0, Math.max(8, Math.floor(err.length * 0.8))).map(x => x[1]);
    let Hn; try { Hn = estimateHomography(order.map(i => src[i]), order.map(i => dst[i])); } catch { break; }
    if (!isPlausible(Hn, w, h)) break; // never let the fit collapse onto a single line
    H = Hn;
  }
  return H;
}

function scaleH(H, s) { // court->downscaled image  ->  court->full image
  return [[H[0][0] / s, H[0][1] / s, H[0][2] / s], [H[1][0] / s, H[1][1] / s, H[1][2] / s], H[2].slice()];
}
function downH(H, s) { return [[H[0][0] * s, H[0][1] * s, H[0][2] * s], [H[1][0] * s, H[1][1] * s, H[1][2] * s], H[2].slice()]; }

export function prepare(img, opts = {}) {
  const g = toGray(img, opts.maxDim || 480), mask = lineMask(g, { tau: opts.tau, contrast: opts.contrast, maxSat: opts.maxSat }), dt = distanceTransform(mask, g.w, g.h);
  return { ...g, mask, dt };
}

/**
 * Fully automatic court detection. Returns {H (court->image, full resolution), score, fraction, support, lines}
 * or {H:null, reason}. The court is symmetric: the result is determined only up to the court's symmetries,
 * so the UI lets the operator flip ends/sides; multi-camera setups should confirm with named keypoints.
 */
export function autoDetectCourt(img, { model = new CourtModel(), maxPerFamily = 6, timeBudgetMs = 4000 } = {}) {
  const t0 = Date.now(), P = prepare(img), { w, h, mask, dt } = P;
  const lines = houghLines(mask, w, h, { maxLines: 18 });
  if (lines.length < 4) return { H: null, reason: `Only ${lines.length} straight court lines visible`, lines, prep: P };
  const [F1, F2] = lineFamilies(lines).map(f => f.sort((a, b) => b.votes - a.votes).slice(0, maxPerFamily));
  if (F1.length < 2 || F2.length < 2) return { H: null, reason: 'Could not find two families of court lines', lines, prep: P };
  const S = model.straightLines(), xs = [...new Set(S.filter(l => l.axis === 'x').map(l => l.value))], ys = [...new Set(S.filter(l => l.axis === 'y').map(l => l.value))];
  const coarse = sampleModel(model, 0.5);
  const pairs = F => { const out = []; for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) out.push([F[i], F[j]]); return out; };
  // The court is symmetric under x->-x and y->-y, so (a,b) and (-a,-b) are equivalent hypotheses: keep one.
  const mpairs = V => { const out = []; for (const a of V) for (const b of V) if (a !== b && (a + b > 1e-9 || (Math.abs(a + b) <= 1e-9 && a > 0))) out.push([a, b]); return out; };
  const top = [];
  let tested = 0;
  outer:
  for (const [FA, FB] of [[F1, F2], [F2, F1]]) for (const [la, lb] of pairs(FA)) for (const [lc, ld] of pairs(FB)) {
    const q = [intersect(la, lc), intersect(la, ld), intersect(lb, lc), intersect(lb, ld)];
    if (q.some(p => !p || Math.abs(p[0]) > 4 * w || Math.abs(p[1]) > 4 * h)) continue;
    for (const [x1, x2] of mpairs(xs)) for (const [y1, y2] of mpairs(ys)) {
      if (Date.now() - t0 > timeBudgetMs) break outer;
      let H; try { H = estimateHomography([[x1, y1], [x1, y2], [x2, y1], [x2, y2]], q); } catch { continue; }
      tested++;
      if (!isPlausible(H, w, h)) continue;
      const sc = scoreHomography(H, dt, w, h, coarse, { minSpacing: 6 });
      if (sc.visible < 25) continue;
      top.push({ H, ...sc }); if (top.length > 60) { top.sort((a, b) => b.score - a.score); top.length = 30; }
    }
  }
  top.sort((a, b) => b.score - a.score);
  const fine = sampleModel(model, 0.1);
  let best = null;
  for (const c of top.slice(0, 6)) {
    const Hr = refineWithMask(c.H, mask, dt, w, h, model);
    const sc = scoreHomography(Hr, dt, w, h, fine);
    if (!best || sc.score > best.score) best = { H: Hr, ...sc };
  }
  if (!best || best.fraction < 0.35) return { H: null, reason: 'No court model hypothesis explains the visible lines well enough', best, tested, lines, prep: P };
  const fineRes = refineHomography(img, scaleH(best.H, P.scale), { model });
  return { H: fineRes.H, score: best.score, fraction: best.fraction, matched: best.matched, visible: best.visible, tested, lines, support: markingSupport(scaleH(best.H, P.scale), P, model), prep: P, elapsedMs: Date.now() - t0 };
}

/** Refine a manual (e.g. 4-point) court->image homography against the detected line pixels. */
export function refineHomography(img, Hfull, { model = new CourtModel(), prep, levels = null } = {}) {
  // coarse-to-fine: refine on a downscaled image first, then at (near) full resolution for sub-pixel accuracy.
  // The wide-search 320 px level is only used when the initial fit is poor (it can jump to wrong lines otherwise).
  let H = Hfull, before = null, after = null, P = null, accepted = false;
  const fine = sampleModel(model, 0.1);
  if (!levels) { const P0 = prepare(img, { maxDim: 480 }); const f0 = scoreHomography(downH(Hfull, P0.scale), P0.dt, P0.w, P0.h, fine).fraction; levels = f0 < 0.5 ? [320, 480, 1100] : [480, 1100]; }
  for (const maxDim of levels) {
    P = (prep && prep.maxDim === maxDim) ? prep : { ...prepare(img, { maxDim, tau: Math.max(3, Math.round(4 * maxDim / 480)) }), maxDim };
    const Hs = downH(H, P.scale);
    const b = scoreHomography(Hs, P.dt, P.w, P.h, fine);
    const radii = maxDim > 600 ? [12, 8, 5, 3, 2] : maxDim <= 320 ? [24, 18, 12, 8, 5, 4] : [16, 10, 6, 4, 3];
    const Hr = refineWithMask(Hs, P.mask, P.dt, P.w, P.h, model, { radii });
    const a = scoreHomography(Hr, P.dt, P.w, P.h, fine);
    if (!before) before = b;
    if (a.score >= b.score) { H = scaleH(Hr, P.scale); accepted = true; after = a; } else after = b;
  }
  return { H, accepted, before, after, support: markingSupport(H, P, model), prep: P };
}

/** Per-marking evidence: fraction of each visible marking's projected samples that land on detected line pixels. */
export function markingSupport(Hfull, P, model = new CourtModel()) {
  const Hs = downH(Hfull, P.scale), groups = {};
  for (const m of model.markings(0.1)) {
    const proj = projectSamples(Hs, m.pts.map(p => ({ p })), P.w, P.h, 3);
    const g = groups[m.group] || (groups[m.group] = { visible: 0, matched: 0 });
    g.visible += proj.length; for (const s of proj) if (P.dt[Math.round(s.v) * P.w + Math.round(s.u)] < 2.5) g.matched++;
  }
  for (const g of Object.values(groups)) { g.fraction = g.visible ? g.matched / g.visible : 0; g.detected = g.visible >= 8 && g.fraction >= 0.5; g.inView = g.visible >= 8; }
  return groups;
}

const SYMS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
/** The 4 symmetric variants of a court->image homography (court is symmetric in x and y). */
export function symmetricVariants(H) { return SYMS.map(([a, b]) => H.map(r => [r[0] * a, r[1] * b, r[2]])); }

/**
 * Calibration policy used by the UI: refine the operator's clicks against the line pixels; if the
 * fit stays weak, run the global automatic detector and use the clicked points only to choose the
 * correct orientation among the court's symmetric solutions. Returns the best-scoring calibration.
 */
export function calibrate(img, Hmanual, { model = new CourtModel(), clicked = null } = {}) {
  const r = refineHomography(img, Hmanual, { model });
  const result = { H: r.H, method: r.accepted ? 'manual+refined' : 'manual', fit: r.after, support: r.support, prep: r.prep };
  const a = autoDetectCourt(img, { model });
  if (!a.H) return { ...result, autoReason: a.reason };
  // orientation: symmetric variant whose projections of the clicked court points are closest to the operator's clicks
  const pts = clicked?.length ? clicked : Object.values(model.keypoints()).map(p => ({ court: p, img: applyH(Hmanual, p) })).filter(p => hDepth(Hmanual, p.court) > 0 && p.img[0] >= 0 && p.img[1] >= 0 && p.img[0] < img.width && p.img[1] < img.height);
  let best = null;
  for (const V of symmetricVariants(a.H)) { let e = 0; for (const p of pts) { const q = applyH(V, p.court); e += Math.hypot(q[0] - p.img[0], q[1] - p.img[1]); } e /= pts.length; if (!best || e < best.e) best = { V, e }; }
  const fine = sampleModel(model, 0.1), P = r.prep, Hs = downH(best.V, P.scale), sc = scoreHomography(Hs, P.dt, P.w, P.h, fine);
  if (sc.score > r.after.score && best.e < 0.15 * Math.max(img.width, img.height)) return { H: best.V, method: 'auto (orientation from clicks)', fit: sc, support: markingSupport(best.V, P, model), prep: P, clickError: best.e };
  return result;
}

/**
 * Half-court canonical orientation (no operator input): among the court's 4 symmetric solutions pick the
 * one where (a) the visible court lies in the +x half (the half-court's basket is always the right basket)
 * and (b) the recovered camera is physically above the floor in a right-handed court frame (zSign = +1).
 * Every camera calibrated this way shares one court frame, which is what cross-camera player IDs need.
 */
export function canonicalHalfCourt(H, width, height) {
  const scored = symmetricVariants(H).map(V => {
    let pos = 0, n = 0;
    for (let x = -14; x <= 14; x += 1) for (let y = -7.5; y <= 7.5; y += 1) {
      if (hDepth(V, [x, y]) <= 0) continue; const q = applyH(V, [x, y]);
      if (q[0] < 0 || q[1] < 0 || q[0] >= width || q[1] >= height) continue;
      // weight by on-screen area of this 1 m cell: the filmed half dominates the image, the far half is compressed
      const qx = applyH(V, [x + 1, y]), qy = applyH(V, [x, y + 1]), a = Math.abs((qx[0] - q[0]) * (qy[1] - q[1]) - (qx[1] - q[1]) * (qy[0] - q[0]));
      n += a; if (x > 0) pos += a;
    }
    let right = 0; try { right = cameraFromHomography(V, width, height).zSign === 1 ? 1 : 0; } catch { }
    return { V, score: (n ? pos / n : 0) + right };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].V;
}

/**
 * Reject false courts (bedrooms, walls, beds produce straight lines too). A real court view must match the
 * model well, show at least two distinct marking groups including a key/free-throw/3-point marking, and give
 * a physically plausible camera (focal length recoverable, 0.5–25 m above the floor, court in front of it).
 */
function invertH3(H) { const [[a, b, c], [d, e, f], [g, h, i]] = H, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, D = a * A + b * B + c * C; return [[A / D, -(b * i - c * h) / D, (b * f - c * e) / D], [B / D, (a * i - c * g) / D, -(a * f - c * d) / D], [C / D, -(a * h - b * g) / D, (a * e - b * d) / D]]; }
export function plausibleCourt(r, width, height) {
  if (!r?.H) return { ok: false, reason: r?.reason || 'no court model fit' };
  if ((r.fraction ?? 0) < 0.6) return { ok: false, reason: `only ${Math.round((r.fraction ?? 0) * 100)}% of the predicted court lines are visible` };
  if (r.prep?.dt) { // significance: busy scenes match random lines by chance
    let near = 0; for (let i = 0; i < r.prep.dt.length; i++) if (r.prep.dt[i] < 2.5) near++;
    const chance = near / r.prep.dt.length;
    if (r.fraction < Math.min(0.95, chance * 2.5 + 0.3)) return { ok: false, reason: `line match ${Math.round(r.fraction * 100)}% is not far above chance (${Math.round(chance * 100)}% of the image looks like lines)` };
  }
  { // the court must occupy a meaningful part of the picture
    let vis = 0, tot = 0; for (let v = 0.5; v < height; v += height / 36) for (let u = 0.5; u < width; u += width / 64) { tot++; const q = applyH(invertH3(r.H), [u, v]); if (q && Math.abs(q[0]) <= 14 && Math.abs(q[1]) <= 7.5) vis++; }
    if (vis / tot < 0.15) return { ok: false, reason: 'detected court covers too little of the picture' };
  }
  const det = Object.entries(r.support || {}).filter(([, g]) => g.detected).map(([k]) => k);
  if (det.length < 2 || !det.some(k => ['key', 'free_throw', 'three_point'].includes(k))) return { ok: false, reason: 'no key / free-throw / 3-point markings found' };
  let cam; try { cam = cameraFromHomography(r.H, width, height); } catch { return { ok: false, reason: 'camera geometry impossible' }; }
  if (!cam.reliable || !(cam.centre[2] > 0.5 && cam.centre[2] < 25)) return { ok: false, reason: 'implausible camera position for a court' };
  return { ok: true, groups: det };
}
