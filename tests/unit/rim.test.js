// Score agent (rim watcher) on synthetic region frames: made basket vs rim bounce vs player noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RimWatcher, fuseBaskets } from '../../public/js/core/rim-watcher.js';

const N = 64, flat = v => Float32Array.from({ length: N }, () => v);
const noisy = (v, a, seed) => Float32Array.from({ length: N }, (_, i) => v + a * Math.sin(i * 1.7 + seed * 2.3));
function play(script) { // script(k) -> {above, net, left, right} brightness offsets
  const w = new RimWatcher(), out = []; for (let k = 0; k < 120; k++) { const s = script(k), f = {}; for (const r of ['above', 'net', 'left', 'right']) f[r] = noisy(100 + (s[r] || 0) * ((k % 2) ? 1 : -1), 1.2, k); const e = w.update(k / 30, f); if (e) out.push(e); } return out;
}
test('made basket: motion above the rim then in the net (not beside it) -> one basket event', () => {
  const ev = play(k => k === 60 || k === 61 ? { above: 40 } : k >= 66 && k <= 72 ? { net: 35, left: 3 } : {});
  assert.equal(ev.length, 1); assert.ok(ev[0].confidence >= 0.6);
});
test('rim bounce: ball arrives above but the side region moves, not the net -> no basket', () => {
  assert.equal(play(k => k === 60 ? { above: 40 } : k >= 64 && k <= 70 ? { right: 40, net: 6 } : {}).length, 0);
});
test('player under the basket (net moves without a ball arriving from above) -> no basket', () => {
  assert.equal(play(k => k >= 50 && k <= 80 ? { net: 30, left: 25, right: 25 } : {}).length, 0);
});
test('two cameras agreeing within 0.7 s fuse into one high-confidence basket', () => {
  const evs = [{ cam: 'cam1', t: 10.0, confidence: 0.7 }, { cam: 'cam2', t: 10.3, confidence: 0.65 }];
  const f = fuseBaskets(evs, 10.4); assert.equal(f.cams.length, 2); assert.ok(f.confidence >= 0.9); assert.equal(fuseBaskets(evs, 10.5), null, 'used once');
});
test('single camera: the basket is emitted after waiting briefly for a second camera', () => {
  const evs = [{ cam: 'cam1', t: 20.0, confidence: 0.8 }];
  assert.equal(fuseBaskets(evs, 20.3), null, 'still waiting for a 2nd camera'); const f = fuseBaskets(evs, 20.8);
  assert.ok(f && f.cams.length === 1 && f.confidence === 0.8); assert.equal(fuseBaskets(evs, 21.0), null, 'counted once');
});
