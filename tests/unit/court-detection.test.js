// Automatic court-line detection on SYNTHETIC renders (players occlude lines, ad-board clutter, noise).
// NOTE: not yet validated on real gym footage — see README "validation status".
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoDetectCourt, refineHomography, calibrate } from '../../public/js/core/court-detection.js';
import { estimateHomography, applyH } from '../../public/js/core/homography.js';
import { CourtModel } from '../../public/js/core/court-model.js';
import { lookAtCamera, renderCourt, meanReprojError } from '../helpers/synth.js';

const m = new CourtModel(), grid = []; for (let x = -14; x <= 14; x++) for (let y = -7.5; y <= 7.5; y++) grid.push([x, y]);
const symErr = (H, cam) => Math.min(...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => meanReprojError(H.map(r => [r[0] * a, r[1] * b, r[2]]), cam.H, grid, cam)));
const views = { 'high sideline': [[2, -13, 7], [8, 0, 0]], 'oblique corner': [[17, -10, 6], [7, 0, 0]] };

for (const [name, [eye, target]] of Object.entries(views)) {
  test(`auto court detection: ${name} view (< 3 px mean error, all markings identified)`, () => {
    const cam = lookAtCamera({ eye, target, f: 1000, width: 1280, height: 720 });
    const r = autoDetectCourt(renderCourt(cam, { seed: 5 }));
    assert.ok(r.H, r.reason); const e = symErr(r.H, cam); assert.ok(e < 3, 'mean error ' + e.toFixed(2));
    for (const g of ['boundary', 'three_point', 'free_throw', 'key']) assert.ok(r.support[g].detected, g + ' detected');
  });
}

test('manual 4-point calibration with click noise is refined against detected lines', () => {
  const cam = lookAtCamera({ eye: [2, -13, 7], target: [8, 0, 0], f: 1000, width: 1280, height: 720 });
  const img = renderCourt(cam, { seed: 9 }), kp = m.keypoints(), names = ['corner_R_bottom', 'key_base_R_top', 'key_ft_R_top', 'key_ft_R_bottom'];
  const clicked = names.map((n, i) => { const q = applyH(cam.H, kp[n]); assert.ok(q[0] > 0 && q[0] < 1280 && q[1] > 0 && q[1] < 720, n + ' visible'); return { court: kp[n], img: [q[0] + [6, -5, 4, -7][i], q[1] + [-5, 6, 5, -4][i]] }; });
  const Hm = estimateHomography(clicked.map(c => c.court), clicked.map(c => c.img));
  const before = meanReprojError(Hm, cam.H, grid, cam), r = calibrate(img, Hm, { clicked }), after = meanReprojError(r.H, cam.H, grid, cam);
  // orientation must be the operator's (no symmetric flip): compare WITHOUT symmetry tolerance
  assert.ok(after < 4, `before ${before.toFixed(2)} after ${after.toFixed(2)} via ${r.method}`);
});

test('small click noise, baseline view: calibration policy reaches < 3 px', () => {
  const cam = lookAtCamera({ eye: [20, 3, 5], target: [6, 0, 0], f: 1000, width: 1280, height: 720 });
  const img = renderCourt(cam, { seed: 2 }), kp = m.keypoints(), names = ['key_base_R_top', 'key_ft_R_top', 'key_ft_R_bottom', 'ft_circle_R'];
  const Hm = estimateHomography(names.map(n => kp[n]), names.map((n, i) => { const q = applyH(cam.H, kp[n]); assert.ok(q[0] > 0 && q[0] < 1280 && q[1] > 0 && q[1] < 720, n + ' visible'); return [q[0] + [3, -2, 2, -3][i], q[1] + [-2, 3, 2, -2][i]]; }));
  const clicked = names.map(n => ({ court: kp[n], img: applyH(Hm, kp[n]) }));
  const r = calibrate(img, Hm, { clicked }), after = meanReprojError(r.H, cam.H, grid, cam);
  assert.ok(after < 3, 'after ' + after.toFixed(2) + ' via ' + r.method);
});

test('a blank / non-court image is rejected instead of producing a fake calibration', () => {
  const W = 640, H = 360, data = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < data.length; i += 4) { data[i] = 120; data[i + 1] = 100; data[i + 2] = 90; data[i + 3] = 255; }
  const r = autoDetectCourt({ width: W, height: H, data }); assert.equal(r.H, null); assert.ok(r.reason);
});
