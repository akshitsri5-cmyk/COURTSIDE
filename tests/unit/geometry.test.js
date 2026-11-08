// Court calibration, homography, camera recovery and triangulation (synthetic ground truth).
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateHomography, applyH, ransacHomography, cameraFromHomography, triangulate, projectP, invertH } from '../../public/js/core/homography.js';
import { CourtModel, FIBA_COURT } from '../../public/js/core/court-model.js';
import { lookAtCamera, seededRng } from '../helpers/synth.js';
import { hungarian } from '../../public/js/core/hungarian.js';

const cam = lookAtCamera({ eye: [2, -13, 7], target: [7, 0, 0], f: 1000, width: 1280, height: 720 });
const cam2 = lookAtCamera({ eye: [17, 9, 6], target: [7, 0, 0], f: 900, width: 1280, height: 720 });
const m = new CourtModel();

test('4-point manual calibration recovers the court->image homography exactly', () => {
  const kp = m.keypoints(), names = ['corner_R_top', 'corner_R_bottom', 'key_ft_R_top', 'key_ft_R_bottom'];
  const H = estimateHomography(names.map(n => kp[n]), names.map(n => applyH(cam.H, kp[n])));
  for (const p of [[0, 0], [10, 3], [12.4, 0], [5, -6]]) { const a = applyH(H, p), b = applyH(cam.H, p); assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6); }
  const back = applyH(invertH(H), applyH(cam.H, [9, 2])); assert.ok(Math.hypot(back[0] - 9, back[1] - 2) < 1e-6, 'image->court mapping');
});

test('RANSAC homography rejects outlier clicks', () => {
  const rng = seededRng(7), src = [], dst = [];
  for (let i = 0; i < 30; i++) { const p = [rng() * 14, rng() * 15 - 7.5]; src.push(p); const q = applyH(cam.H, p); dst.push(i % 6 === 0 ? [q[0] + 80, q[1] - 60] : [q[0] + rng() - 0.5, q[1] + rng() - 0.5]); }
  const { H, inliers } = ransacHomography(src, dst, { rng: seededRng(3) });
  assert.equal(inliers.length, 25);
  const a = applyH(H, [8, 1]), b = applyH(cam.H, [8, 1]); assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5);
});

test('camera pose recovered from a court homography (focal length, height above floor)', () => {
  const c = cameraFromHomography(cam.H, 1280, 720);
  assert.ok(c.reliable); assert.ok(Math.abs(c.f - 1000) < 5, 'focal ' + c.f);
  assert.ok(Math.abs(c.centre[2] - 7) < 0.1 && Math.hypot(c.centre[0] - 2, c.centre[1] + 13) < 0.2, 'camera centre ' + c.centre);
  const rim = projectP(c.P, [12.425, 0, 3.05]), truth = projectP(cam.P, [12.425, 0, 3.05]);
  assert.ok(Math.hypot(rim[0] - truth[0], rim[1] - truth[1]) < 2, 'rim projection (3.05 m above floor)');
});

test('multi-view triangulation of the ball in 3-D', () => {
  const c1 = cameraFromHomography(cam.H, 1280, 720), c2 = cameraFromHomography(cam2.H, 1280, 720);
  const X = [9.3, 1.2, 3.4];
  const r = triangulate([{ P: c1.P, pt: projectP(cam.P, X) }, { P: c2.P, pt: projectP(cam2.P, X) }]);
  assert.ok(Math.hypot(r.X[0] - X[0], r.X[1] - X[1], r.X[2] - X[2]) < 0.05, 'triangulated ' + r.X);
});

test('FIBA court regions: boundary line is out, 3-point line is 2PT, restricted area', () => {
  assert.equal(m.isOut([0, 0]), false); assert.equal(m.isOut([13.97, 0]), true, 'on the endline = out');
  assert.equal(m.isOut([14.2, 0]), true);
  assert.equal(m.isThreePoint([12.425 - 6.80, 0]), true); assert.equal(m.isThreePoint([12.425 - 6.70, 0]), false);
  assert.equal(m.isThreePoint([13, 6.65]), true, 'corner three'); assert.equal(m.isThreePoint([13, 6.55]), false);
  assert.equal(m.inRestrictedArea([12.425 - 1.2, 0]), true); assert.equal(m.inRestrictedArea([12.425 - 1.3, 0]), false);
  assert.ok(Math.abs(m.tpArcX - (12.425 - Math.sqrt(6.75 ** 2 - 6.6 ** 2))) < 1e-9);
  assert.equal(FIBA_COURT.length, 28);
});

test('Hungarian assignment (rectangular, with max cost)', () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(hungarian([[1, 9], [9, 1], [5, 5]]), [0, 1, -1]);
  assert.deepEqual(hungarian([[10, 10]], 5), [-1]);
});
