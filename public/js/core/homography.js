// Homography estimation (normalised DLT + RANSAC), projective camera recovery
// from a planar homography, and multi-view triangulation.
import { nullVector, inv3, matMul, matVec, cross, norm, scale, dot, sub, det3 } from './linalg.js';

function normaliser(pts) {
  const n = pts.length; let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= n; my /= n;
  let d = 0; for (const [x, y] of pts) d += Math.hypot(x - mx, y - my); d = d / n || 1;
  const s = Math.SQRT2 / d; return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
}

/** Estimate H mapping src -> dst (each [[x,y],...], N >= 4). Throws on degenerate input. */
export function estimateHomography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) throw new Error('Need >= 4 point correspondences');
  const Ts = normaliser(src), Td = normaliser(dst), A = [];
  for (let i = 0; i < src.length; i++) {
    const [x, y] = applyH(Ts, src[i]), [u, v] = applyH(Td, dst[i]);
    A.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    A.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  const h = nullVector(A), Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
  let H = matMul(inv3(Td), matMul(Hn, Ts));
  if (!H.flat().every(Number.isFinite) || Math.abs(det3(H)) < 1e-18) throw new Error('Degenerate homography');
  const s = H[2][2] !== 0 ? H[2][2] : 1; H = H.map(r => r.map(v => v / s));
  return H;
}

export function applyH(H, [x, y]) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}
/** True if the point maps with positive projective depth (i.e. not across the horizon). */
export function hDepth(H, [x, y]) { return H[2][0] * x + H[2][1] * y + H[2][2]; }
export function invertH(H) { return inv3(H); }

export function reprojectionErrors(H, src, dst) { return src.map((p, i) => { const q = applyH(H, p); return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]); }); }

/** Robust homography with RANSAC; returns {H, inliers}. rng injectable for deterministic tests. */
export function ransacHomography(src, dst, { threshold = 3, iterations = 500, rng = Math.random } = {}) {
  const n = src.length; if (n < 4) throw new Error('Need >= 4 points');
  let best = null, bestIn = [];
  for (let it = 0; it < iterations; it++) {
    const idx = new Set(); while (idx.size < 4) idx.add(Math.floor(rng() * n));
    const ids = [...idx]; let H;
    try { H = estimateHomography(ids.map(i => src[i]), ids.map(i => dst[i])); } catch { continue; }
    const errs = reprojectionErrors(H, src, dst), inl = [];
    errs.forEach((e, i) => { if (e < threshold) inl.push(i); });
    if (inl.length > bestIn.length) { bestIn = inl; best = H; if (inl.length === n) break; }
  }
  if (!best) throw new Error('RANSAC failed');
  if (bestIn.length >= 4) best = estimateHomography(bestIn.map(i => src[i]), bestIn.map(i => dst[i]));
  return { H: best, inliers: bestIn };
}

/**
 * Recover a pinhole camera from a court->image homography assuming square pixels,
 * zero skew and principal point at the image centre (standard single-view assumptions).
 * World frame: court plane z = 0, z pointing UP (height above floor).
 * Returns {K, R, t, P, f, centre, reliable}. `reliable` is false when the focal length
 * is poorly constrained (e.g. camera looking straight down) and a default was used.
 */
export function cameraFromHomography(Hc2i, width, height) {
  const cx = width / 2, cy = height / 2;
  const T = [[1, 0, -cx], [0, 1, -cy], [0, 0, 1]];
  const Hp = matMul(T, Hc2i);
  const h1 = [Hp[0][0], Hp[1][0], Hp[2][0]], h2 = [Hp[0][1], Hp[1][1], Hp[2][1]];
  const cands = [];
  const d1 = h1[2] * h2[2]; if (Math.abs(d1) > 1e-12) { const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / d1; if (f2 > 0) cands.push(f2); }
  const d2 = h1[2] * h1[2] - h2[2] * h2[2]; if (Math.abs(d2) > 1e-12) { const f2 = -(h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2) / d2; if (f2 > 0) cands.push(f2); }
  let f, reliable = true;
  const plausible = cands.map(Math.sqrt).filter(v => v > 0.2 * Math.max(width, height) && v < 20 * Math.max(width, height));
  if (plausible.length) f = plausible.reduce((a, b) => a + b, 0) / plausible.length; else { f = 1.0 * Math.max(width, height); reliable = false; }
  const K = [[f, 0, cx], [0, f, cy], [0, 0, 1]];
  const Kinv = inv3(K), H = Hc2i;
  let r1 = matVec(Kinv, [H[0][0], H[1][0], H[2][0]]), r2 = matVec(Kinv, [H[0][1], H[1][1], H[2][1]]), t = matVec(Kinv, [H[0][2], H[1][2], H[2][2]]);
  let lam = 2 / (norm(r1) + norm(r2));
  r1 = scale(r1, lam); r2 = scale(r2, lam); t = scale(t, lam);
  if (t[2] < 0) { r1 = scale(r1, -1); r2 = scale(r2, -1); t = scale(t, -1); } // court origin in front of camera
  // Orthonormalise r1, r2 (symmetric correction).
  const c12 = dot(r1, r2) / 2; let a = sub(r1, scale(r2, c12)), b = sub(r2, scale(r1, c12));
  a = scale(a, 1 / norm(a)); b = scale(b, 1 / norm(b));
  let r3 = cross(a, b);
  // r3 is the world z axis expressed in camera coords; we require camera ABOVE the floor (centre z > 0).
  let R = [[a[0], b[0], r3[0]], [a[1], b[1], r3[1]], [a[2], b[2], r3[2]]];
  let centre = matVec(transpose3(R), t).map(v => -v);
  let zSign = 1;
  if (centre[2] < 0) { // court axes are left-handed relative to "up": flip world z
    zSign = -1; r3 = scale(r3, -1); R = [[a[0], b[0], r3[0]], [a[1], b[1], r3[1]], [a[2], b[2], r3[2]]];
    centre = matVec(transpose3(R), t).map(v => -v);
  }
  const P = matMul(K, R.map((row, i) => [...row, t[i]]));
  return { K, R, t, P, f, centre, reliable, zSign };
}
function transpose3(m) { return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]; }

export function projectP(P, [X, Y, Z]) {
  const v = matVec(P, [X, Y, Z, 1]); return v[2] > 1e-9 ? [v[0] / v[2], v[1] / v[2]] : null;
}

/** Linear (DLT) triangulation from >= 2 views: views = [{P, pt:[u,v]}]. Returns {X, reprojError}. */
export function triangulate(views) {
  if (views.length < 2) throw new Error('Need at least two views');
  const A = [];
  for (const { P, pt: [u, v] } of views) {
    A.push(P[2].map((p, i) => u * p - P[0][i]));
    A.push(P[2].map((p, i) => v * p - P[1][i]));
  }
  const X = nullVector(A); const w = X[3];
  if (Math.abs(w) < 1e-12) throw new Error('Point at infinity');
  const P3 = [X[0] / w, X[1] / w, X[2] / w];
  const errs = views.map(({ P, pt }) => { const q = projectP(P, P3); return q ? Math.hypot(q[0] - pt[0], q[1] - pt[1]) : Infinity; });
  return { X: P3, reprojError: Math.max(...errs) };
}

/** Ray-plane helper: back-project image point onto horizontal plane z = h using camera {K,R,t}. */
export function backprojectToHeight(cam, [u, v], h = 0) {
  const Kinv = inv3(cam.K), d = matVec(Kinv, [u, v, 1]);
  const Rt = transpose3(cam.R), dir = matVec(Rt, d), C = cam.centre;
  if (Math.abs(dir[2]) < 1e-9) return null; const s = (h - C[2]) / dir[2]; if (s <= 0) return null;
  return [C[0] + s * dir[0], C[1] + s * dir[1], h];
}
