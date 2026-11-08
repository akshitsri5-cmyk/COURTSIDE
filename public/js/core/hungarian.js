// Hungarian (Kuhn-Munkres) algorithm for rectangular cost matrices, O(n^3).
// Returns array `assign` where assign[row] = col or -1. Pairs with cost >= maxCost are left unassigned.
export function hungarian(cost, maxCost = Infinity) {
  const nR = cost.length; if (!nR) return [];
  const nC = cost[0].length; if (!nC) return new Array(nR).fill(-1);
  const n = Math.max(nR, nC), BIG = 1e9;
  const a = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i >= 1 && j >= 1 && i <= nR && j <= nC) ? Math.min(cost[i - 1][j - 1], BIG) : (i && j ? BIG / 10 : 0)));
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = a[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assign = new Array(nR).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] >= 1 && p[j] <= nR && j <= nC && cost[p[j] - 1][j - 1] < maxCost) assign[p[j] - 1] = j - 1;
  return assign;
}
