// Small dense linear-algebra helpers (no dependencies). Used by homography,
// camera-model estimation and triangulation. Works in browser and Node.

export function zeros(r, c) { return Array.from({ length: r }, () => new Array(c).fill(0)); }
export function identity(n) { const m = zeros(n, n); for (let i = 0; i < n; i++) m[i][i] = 1; return m; }
export function transpose(a) { return a[0].map((_, j) => a.map(row => row[j])); }
export function matMul(a, b) {
  const r = a.length, k = b.length, c = b[0].length, out = zeros(r, c);
  for (let i = 0; i < r; i++) for (let p = 0; p < k; p++) { const v = a[i][p]; if (v === 0) continue; for (let j = 0; j < c; j++) out[i][j] += v * b[p][j]; }
  return out;
}
export function matVec(a, v) { return a.map(row => row.reduce((s, x, i) => s + x * v[i], 0)); }
export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
export function norm(a) { return Math.sqrt(dot(a, a)); }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function scale(a, s) { return a.map(x => x * s); }
export function sub(a, b) { return a.map((x, i) => x - b[i]); }
export function add(a, b) { return a.map((x, i) => x + b[i]); }

export function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
export function inv3(m) {
  const d = det3(m);
  if (Math.abs(d) < 1e-14) throw new Error('Singular 3x3 matrix');
  const [a, b, c] = m[0], [e, f, g] = m[1], [h, i, j] = m[2];
  return [
    [(f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d],
    [(g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d],
    [(e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d],
  ];
}

/** Solve A x = b (square) by Gaussian elimination with partial pivoting. */
export function solve(A, b) {
  const n = A.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Singular system');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Jacobi eigen-decomposition of a symmetric matrix. Returns {values, vectors} with vectors as columns, sorted ascending. */
export function eigSym(S) {
  const n = S.length, A = S.map(r => [...r]), V = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = [...Array(n).keys()].sort((i, j) => A[i][i] - A[j][j]);
  return { values: idx.map(i => A[i][i]), vectors: V.map(row => idx.map(i => row[i])) };
}

/** Least-squares null vector of A (rows x n): eigenvector of A^T A with the smallest eigenvalue. */
export function nullVector(A) {
  const n = A[0].length, AtA = zeros(n, n);
  for (const row of A) for (let i = 0; i < n; i++) { if (row[i] === 0) continue; for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j]; }
  const { vectors } = eigSym(AtA);
  return vectors.map(r => r[0]);
}

export function median(arr) {
  if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
