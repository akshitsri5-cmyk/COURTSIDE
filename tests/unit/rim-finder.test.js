// Automatic rim finder on SYNTHETIC scenes (hoop with backboard + net, plus orange distractors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findRimCandidates, RimFinder } from '../../public/js/core/rim-finder.js';

function scene({ hoop = true, ballAt = null, seed = 1 } = {}) {
  const W = 640, H = 360, d = new Uint8ClampedArray(W * H * 4); let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = 4 * (y * W + x), sky = y < 150; d[i] = sky ? 120 + rnd() * 20 : 150 + rnd() * 25; d[i + 1] = sky ? 150 + rnd() * 20 : 120 + rnd() * 20; d[i + 2] = sky ? 170 + rnd() * 20 : 90 + rnd() * 20; d[i + 3] = 255; }
  const px = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return; const i = 4 * (y * W + x); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; };
  if (hoop) {
    for (let y = 40; y < 105; y++) for (let x = 300; x < 400; x++) px(x, y, [235, 235, 235]);                 // white backboard
    for (let y = 70; y < 100; y++) for (let x = 335; x < 365; x++) if (y === 70 || y === 99 || x === 335 || x === 364) px(x, y, [200, 40, 40]); // inner square
    for (let a = 0; a < 2 * Math.PI; a += 0.005) for (let t = -1; t <= 1; t++) px(350 + 26 * Math.cos(a), 110 + t + 5 * Math.sin(a), [220, 80, 30]); // orange rim (flat ellipse)
    for (let y = 116; y < 150; y++) for (let x = 330; x < 371; x++) if ((x + y) % 5 === 0 || (x - y) % 5 === 0) px(x, y, [245, 245, 245]); // net mesh
  }
  if (ballAt) for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) if (x * x + y * y <= 100) px(ballAt[0] + x, ballAt[1] + y, [215, 100, 35]); // orange ball
  for (let y = 300; y < 330; y++) for (let x = 60; x < 75; x++) px(x + (y - 300) * 0.2, y, [230, 90, 20]); // orange cone on the floor
  for (let y = 210; y < 280; y++) for (let x = 480; x < 520; x++) px(x, y, [200, 30, 30]); // red shirt
  return { width: W, height: H, data: d };
}

test('finds the rim (orange ring + backboard + net) and ignores ball, cone and red shirt', () => {
  const c = findRimCandidates(scene({ ballAt: [200, 120] }))[0];
  assert.ok(c && Math.hypot(c.u - 350, c.v - 110) < 6 && Math.abs(c.rx - 26) < 6, JSON.stringify(c));
});
test('no hoop in view -> no confident rim', () => {
  const f = new RimFinder(); let r = null; for (let k = 0; k < 5; k++) r = f.look(scene({ hoop: false, ballAt: [200 + 40 * k, 120], seed: k })); assert.equal(r, null);
});
test('rim is reported only after it is seen in the same place repeatedly', () => {
  const f = new RimFinder(); assert.equal(f.look(scene({ seed: 1 })), null); assert.equal(f.look(scene({ seed: 2 })), null);
  const r = f.look(scene({ seed: 3, ballAt: [345, 60] })); assert.ok(r && r.source === 'auto' && Math.hypot(r.u - 350, r.v - 110) < 6, JSON.stringify(r));
});
