// Synthetic scene generator for unit tests. Everything here is SYNTHETIC ground truth,
// used to verify geometry and logic. It is NOT a substitute for labelled real footage.
import { CourtModel } from '../../public/js/core/court-model.js';
import { matMul, cross, norm, scale, sub } from '../../public/js/core/linalg.js';

export function lookAtCamera({ eye, target, f, width, height }) {
  const up = [0, 0, 1];
  let zc = sub(target, eye); zc = scale(zc, 1 / norm(zc));          // camera forward
  let xc = cross(zc, up); xc = scale(xc, 1 / norm(xc));               // camera right
  const yc = cross(zc, xc);                                           // camera down
  const R = [xc, yc, zc];
  const t = R.map(r => -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]));
  const K = [[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]];
  const P = matMul(K, R.map((row, i) => [...row, t[i]]));
  const H = [[P[0][0], P[0][1], P[0][3]], [P[1][0], P[1][1], P[1][3]], [P[2][0], P[2][1], P[2][3]]];
  return { K, R, t, P, H, width, height, eye };
}

export function project(P, [X, Y, Z]) {
  const u = P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3], v = P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3], w = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];
  return w > 0 ? [u / w, v / w] : null;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Render an RGBA court image as seen by camera `cam`. */
export function renderCourt(cam, { seed = 1, noise = 10, occluders = 6, clutterLines = 2, model = new CourtModel() } = {}) {
  const { width: W, height: H } = cam, data = new Uint8ClampedArray(W * H * 4), r = rng(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, grain = 12 * Math.sin(x * 0.05 + Math.sin(y * 0.01) * 3);
    data[i] = 190 + grain + (r() - 0.5) * noise; data[i + 1] = 135 + grain * 0.7 + (r() - 0.5) * noise; data[i + 2] = 80 + (r() - 0.5) * noise; data[i + 3] = 255;
  }
  // stands (top of image above the far sideline) – darker area
  const paint = (u, v, rad, col) => { for (let yy = Math.floor(v - rad); yy <= v + rad; yy++) for (let xx = Math.floor(u - rad); xx <= u + rad; xx++) { if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; if ((xx - u) ** 2 + (yy - v) ** 2 > rad * rad) continue; const i = (yy * W + xx) * 4; data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; } };
  for (const m of model.markings(0.01)) for (const p of m.pts) {
    const q = project(cam.P, [p[0], p[1], 0]); if (!q) continue;
    // line width 5 cm projected: estimate pixel size from neighbour
    const q2 = project(cam.P, [p[0] + 0.05, p[1], 0]); const rad = Math.min(6, Math.max(0.8, q2 ? Math.hypot(q2[0] - q[0], q2[1] - q[1]) / 1.4 : 1)); // cap: points near the horizon
    paint(q[0], q[1], rad, [245, 245, 240]);
  }
  for (let k = 0; k < clutterLines; k++) { // advertising / non-court bright lines
    const y0 = r() * H * 0.2, x0 = r() * W, x1 = r() * W; for (let t = 0; t <= 1; t += 0.001) paint(x0 + (x1 - x0) * t, y0, 1, [250, 250, 250]);
  }
  for (let k = 0; k < occluders; k++) { // players standing on the court occluding lines
    const px = (r() - 0.2) * 14, py = (r() - 0.5) * 12, foot = project(cam.P, [px, py, 0]), head = project(cam.P, [px, py, 1.95]);
    if (!foot || !head) continue; const hgt = foot[1] - head[1], wid = hgt * 0.3;
    for (let yy = Math.floor(head[1]); yy < foot[1]; yy++) for (let xx = Math.floor(foot[0] - wid / 2); xx < foot[0] + wid / 2; xx++) { if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const i = (yy * W + xx) * 4; data[i] = 30; data[i + 1] = 40 + k * 20; data[i + 2] = 120; }
  }
  return { width: W, height: H, data };
}

export function meanReprojError(Hest, Htrue, pts, cam) {
  let s = 0, n = 0;
  for (const p of pts) {
    const a = applyHH(Htrue, p), b = applyHH(Hest, p);
    if (!a || !b) continue; if (a[0] < 0 || a[1] < 0 || a[0] > cam.width || a[1] > cam.height) continue;
    s += Math.hypot(a[0] - b[0], a[1] - b[1]); n++;
  }
  return n ? s / n : Infinity;
}
function applyHH(H, [x, y]) { const w = H[2][0] * x + H[2][1] * y + H[2][2]; if (w <= 0) return null; return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]; }

export function seededRng(seed) { return rng(seed); }
