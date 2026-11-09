// Scripted synthetic plays used by the unit tests and the demo.
import { Scenario, path, gait, lerp, STANDARD_CAMS } from './scenario.js';

export const stand = (pos, facing = 0) => () => ({ pos, facing, feet: { L: [pos[0], pos[1] + 0.13, 0], R: [pos[0], pos[1] - 0.13, 0] } });
export const walker = keys => { const P = path(keys); return t => { const p = P(t); return { pos: p, feet: { L: [p[0], p[1] + 0.13, 0], R: [p[0], p[1] - 0.13, 0] } }; }; };

/** Ball dribbled at the right hand of a player at `pos` (stationary). Bounces at t = 0.25, 0.75, ... */
export function dribbleBall(pos, facing, t) {
  const d = [Math.cos(facing), Math.sin(facing)], n = [-d[1], d[0]];
  const z = 0.12 + 0.68 * Math.abs(Math.cos(2 * Math.PI * t));
  return [pos[0] + 0.3 * d[0] - 0.35 * n[0], pos[1] + 0.3 * d[1] - 0.35 * n[1], z];
}
export function chestBall(pos, facing) { const d = [Math.cos(facing), Math.sin(facing)]; return [pos[0] + 0.35 * d[0], pos[1] + 0.35 * d[1], 1.1]; }
export function handsOnBall(B, facing) { const d = [Math.cos(facing), Math.sin(facing)], n = [-d[1], d[0]]; return { L: [B[0] + 0.13 * n[0], B[1] + 0.13 * n[1], B[2]], R: [B[0] - 0.13 * n[0], B[1] - 0.13 * n[1], B[2]] }; }

/** A dribbles (t 0..2), holds (2..2.6), passes to B (2.6..3.2), B holds. Optional: A re-dribbles at 2.6 instead (double dribble). */
export function dribblePassPlay({ doubleDribble = false } = {}) {
  const A = [6, 0], B = [9.5, 2.5], fa = Math.atan2(B[1] - A[1], B[0] - A[0]), fb = fa + Math.PI;
  const ball = t => {
    if (t < 2) return dribbleBall(A, fa, t);
    if (t < 2.6) return chestBall(A, fa);
    if (doubleDribble) return dribbleBall(A, fa, t - 2.6 + 0.0);
    if (t < 3.2) { const k = (t - 2.6) / 0.6, p = lerp(chestBall(A, fa), chestBall(B, fb), k); p[2] += 0.4 * Math.sin(Math.PI * k); return p; }
    return chestBall(B, fb);
  };
  const handsA = t => {
    const Bt = ball(t);
    if (t < 2 || (doubleDribble && t >= 2.6)) { const d = [Math.cos(fa), Math.sin(fa)], n = [-d[1], d[0]]; return { R: [Bt[0], Bt[1], 0.95], L: [A[0] + 0.1 * d[0] + 0.27 * n[0], A[1] + 0.1 * d[1] + 0.27 * n[1], 0.88] }; }
    if (t < 2.62) return handsOnBall(Bt, fa);
    return null;
  };
  const handsB = t => t >= 3.18 && !doubleDribble ? handsOnBall(ball(t), fb) : null;
  const sc = new Scenario({ cameras: STANDARD_CAMS })
    .addPlayer({ id: 'A', team: 0, state: t => ({ ...stand(A, fa)(), hands: handsA(t) }) })
    .addPlayer({ id: 'B', team: 0, state: t => ({ ...stand(B, fb)(), hands: handsB(t) }) })
    .setBall(ball);
  return sc;
}

/**
 * Travelling: B catches a pass while moving and takes `steps` steps before passing.
 * Foot plants are scripted: zero step (L planted at the catch), then alternate R, L, R...
 */
export function catchAndStepPlay({ steps = 3, catchT = 1.0 } = {}) {
  const Q = [8, -1], P0 = [3, 0], f = 0;
  const contacts = []; let x = 3.0; const stride = 0.75;
  // approach run before the catch
  let t = 0.1, foot = 'R';
  while (t < catchT - 0.05) { contacts.push({ foot, t0: t, t1: t + 0.18, at: [x, foot === 'L' ? 0.13 : -0.13] }); x += stride; t += 0.3; foot = foot === 'L' ? 'R' : 'L'; }
  // zero step: L planted through the catch
  contacts.push({ foot: 'L', t0: catchT - 0.1, t1: catchT + 0.15, at: [x, 0.13] }); x += stride;
  let tt = catchT + 0.3; let ff = 'R';
  for (let i = 0; i < steps; i++) { contacts.push({ foot: ff, t0: tt, t1: tt + 0.18, at: [x, ff === 'L' ? 0.13 : -0.13] }); x += stride; tt += 0.32; ff = ff === 'L' ? 'R' : 'L'; }
  const releaseT = tt + 0.05;
  const g = gait(contacts, { L: [2.6, 0.13], R: [2.6, -0.13] });
  const feet = t => ({ L: g('L', t), R: g('R', t) });
  const body = t => { const F = feet(t); return [(F.L[0] + F.R[0]) / 2, 0]; };
  const ball = t => {
    if (t < catchT) { const k = t / catchT; const p = lerp([Q[0], Q[1], 1.2], [...chestBall(body(catchT), f)], k); p[2] += 0.5 * Math.sin(Math.PI * k); return p; }
    if (t < releaseT) return chestBall(body(t), f);
    const k = Math.min(1, (t - releaseT) / 0.6); return lerp(chestBall(body(releaseT), f), [Q[0], Q[1], 1.2], k);
  };
  const sc = new Scenario({ cameras: STANDARD_CAMS })
    .addPlayer({ id: 'B', team: 0, state: t => ({ pos: body(t), facing: f, feet: feet(t), hands: t >= catchT - 0.02 && t < releaseT ? handsOnBall(ball(t), f) : null }) })
    .addPlayer({ id: 'Q', team: 0, state: t => ({ ...stand(Q, Math.PI)(), hands: t < 0.08 || t > releaseT + 0.58 ? handsOnBall(ball(t), Math.PI) : null }) })
    .setBall(ball);
  return { sc, releaseT, contacts };
}

/** Loose ball bouncing at `bounceAt` (court xy) at time 1.0. */
export function looseBallPlay(bounceAt = [9, 8.2]) {
  const start = [7, 3, 1.5];
  const ball = t => { if (t > 2) return null; if (t <= 1) { const k = t; return [start[0] + (bounceAt[0] - start[0]) * k, start[1] + (bounceAt[1] - start[1]) * k, 0.12 + (1.38) * (1 - k * k)]; } const k = t - 1; return [bounceAt[0] + 1 * k, bounceAt[1] + 1.5 * k, 0.12 + 3.5 * k - 4.9 * k * k]; };
  const sc = new Scenario({ cameras: STANDARD_CAMS }).addPlayer({ id: 'X', team: 1, state: stand([4, -4], 0) }).setBall(ball);
  return sc;
}

/** Jump shot from `spot`, ball released at t=1.0 and passing through (made) or beside (missed) the right rim. */
export function jumpShotPlay({ spot = [5.2, 0.5], made = true, team = 0 } = {}) {
  const rim = [12.425, 0, 3.05], tr = 1.0, T = 1.1, target = made ? rim : [rim[0], rim[1] + 0.55, rim[2]];
  const g = 9.81, R0 = [spot[0] + 0.2, spot[1], 2.4];
  // ballistic velocity to reach target at time T then fall through (made: continue to floor)
  const V = [(target[0] - R0[0]) / T, (target[1] - R0[1]) / T, (target[2] - R0[2] + 0.5 * g * T * T) / T];
  const facing = Math.atan2(rim[1] - spot[1], rim[0] - spot[0]);
  const jump = t => (t > 0.75 && t < 1.35) ? 0.35 * Math.sin(Math.PI * (t - 0.75) / 0.6) : 0;
  const ball = t => {
    if (t < tr) { const k = Math.max(0, (t - 0.5) / 0.5); return [R0[0] - 0.05, R0[1], 1.1 + (R0[2] - 1.1) * k + jump(t) * 0]; }
    const d = t - tr; const p = [R0[0] + V[0] * d, R0[1] + V[1] * d, R0[2] + V[2] * d - 0.5 * g * d * d];
    if (made && p[2] < 0.12) return null;
    return p[2] < 0.12 ? null : p;
  };
  const hands = t => { if (t >= tr) return t < tr + 0.25 ? { L: [R0[0] - 0.05, R0[1] + 0.1, 2.5], R: [R0[0], R0[1] - 0.1, 2.55] } : null; const B = ball(t); return handsOnBall(B, facing); };
  const sc = new Scenario({ cameras: STANDARD_CAMS })
    .addPlayer({ id: 'S', team, state: t => ({ pos: spot, facing, jump: jump(t), feet: { L: [spot[0], spot[1] + 0.13, 0], R: [spot[0], spot[1] - 0.13, 0] }, hands: hands(t) }) })
    .addPlayer({ id: 'D', team: 1 - team, state: stand([spot[0] + 2.5, spot[1] - 1.5], Math.PI) })
    .setBall(ball);
  return sc;
}

/**
 * Contact plays. kind: 'charge' (attacker runs into a set defender), 'block' (defender slides into the
 * attacker's path at contact), 'none' (players pass 3 m apart in depth: overlap in one camera only).
 * Contact happens at tContact = 2.5 s (team clustering needs ~2 s of observations).
 */
export function contactPlay(kind = 'charge', { oneVsOne = false } = {}) {
  const tC = 2.5, H0 = [5.5, 0], v = 1.6; // attacker speed (m/s) along +x
  const hx = t => Math.min(H0[0] + v * t, H0[0] + v * tC); // attacker stops at contact (impact)
  const Dset = [H0[0] + v * tC + 0.38, 0];
  let Dpos;
  if (kind === 'charge') Dpos = t => t < tC ? Dset : [Dset[0] + Math.min(0.35, (t - tC) * 1.2), 0];
  else if (kind === 'block') Dpos = t => { const y = Math.max(0, 2.2 - 2.2 * Math.max(0, (t - (tC - 1.1)) / 1.1)); return [Dset[0], y]; };
  else Dpos = t => { const h = [H0[0] + v * t, 0], c = STANDARD_CAMS[0].eye, d = [h[0] - c[0], h[1] - c[1]], n = Math.hypot(...d); return [h[0] + 3 * d[0] / n, h[1] + 3 * d[1] / n]; }; // 3 m behind H on cam1's line of sight
  const H = t => [kind === 'none' ? H0[0] + v * t : hx(t), 0];
  const ball = t => chestBall(H(t), 0);
  const sc = new Scenario({ cameras: STANDARD_CAMS })
    .addPlayer({ id: 'H', team: 0, state: t => ({ ...stand(H(t), 0)(), hands: handsOnBall(ball(t), 0) }) })
    .addPlayer({ id: 'D', team: 1, state: t => ({ ...stand(Dpos(t), Math.PI)() }) })
    .setBall(ball);
  if (!oneVsOne) sc.addPlayer({ id: 'O', team: 0, state: stand([4, -4], 0) }).addPlayer({ id: 'E', team: 1, state: stand([3, 4], 0) });
  return { sc, tC };
}
