// Quick demonstration of the core modules on SYNTHETIC data (not real footage).
import { lookAtCamera, renderCourt, meanReprojError } from '../tests/helpers/synth.js';
import { autoDetectCourt, refineHomography } from '../public/js/core/court-detection.js';
import { CourtModel } from '../public/js/core/court-model.js';
import { estimateHomography, applyH } from '../public/js/core/homography.js';
import { PlayerTracker } from '../public/js/core/player-tracking.js';
import { RuleEngine } from '../public/js/core/rule-engine.js';
import { getRuleset } from '../public/js/core/rules/rulesets.js';

const m = new CourtModel(), grid = []; for (let x = -14; x <= 14; x++) for (let y = -7.5; y <= 7.5; y++) grid.push([x, y]);
console.log('=== 1. Automatic court-line detection (synthetic 1280x720 renders, players occluding lines) ===');
for (const [name, eye, target] of [['sideline-high', [2, -13, 7], [8, 0, 0]], ['baseline', [20, 3, 5], [6, 0, 0]], ['corner', [17, -10, 6], [7, 0, 0]], ['centre-wide', [0, -16, 8], [0, 0, 0]]]) {
  const cam = lookAtCamera({ eye, target, f: 1000, width: 1280, height: 720 }), img = renderCourt(cam, { seed: 3 });
  const r = autoDetectCourt(img);
  const err = Math.min(...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => meanReprojError(r.H.map(row => [row[0] * a, row[1] * b, row[2]]), cam.H, grid, cam)));
  const kp = m.keypoints(), names = ['corner_R_top', 'corner_R_bottom', 'key_ft_R_top', 'key_ft_R_bottom'];
  const Hm = estimateHomography(names.map(n => kp[n]), names.map(n => { const q = applyH(cam.H, kp[n]); return [q[0] + 6, q[1] - 5]; }));
  const rr = refineHomography(img, Hm);
  console.log(`${name.padEnd(13)} auto: ${err.toFixed(2)} px mean error in ${r.elapsedMs} ms | markings found: ${Object.entries(r.support).map(([k, v]) => `${k} ${Math.round(v.fraction * 100)}%`).join(', ')}`);
  console.log(`${''.padEnd(13)} manual 4-click (6px noise): ${meanReprojError(Hm, cam.H, grid, cam).toFixed(2)} px -> after line refinement ${meanReprojError(rr.H, cam.H, grid, cam).toFixed(2)} px`);
}
console.log('\n=== 2. Tracker: two players cross paths (same size, different jerseys) ===');
const tr = new PlayerTracker(); const embA = { jersey: Float32Array.from({ length: 52 }, (_, i) => i === 0 ? 1 : 0), shorts: Float32Array.from({ length: 52 }, (_, i) => i === 0 ? 1 : 0) };
const embB = { jersey: Float32Array.from({ length: 52 }, (_, i) => i === 30 ? 1 : 0), shorts: Float32Array.from({ length: 52 }, (_, i) => i === 30 ? 1 : 0) };
const ids = { A: new Set(), B: new Set() };
for (let k = 0; k < 40; k++) {
  const t = k / 15, xa = 100 + k * 12, xb = 580 - k * 12;
  const dets = []; if (Math.abs(xa - xb) > 30) { dets.push({ bbox: [xa, 200, 50, 150], score: 0.9, emb: embA, gt: 'A' }); dets.push({ bbox: [xb, 205, 50, 150], score: 0.9, emb: embB, gt: 'B' }); }
  else dets.push({ bbox: [xa, 200, 50, 150], score: 0.9, emb: embA, gt: 'A' }); // B hidden behind A while crossing
  tr.update(dets, t);
  for (const d of dets) { const m2 = tr.active().find(x => x.det === d); if (m2) ids[d.gt].add(m2.id); }
}
console.log('IDs assigned to player A:', [...ids.A].join(','), '| player B:', [...ids.B].join(','), '(one ID each = no swap, B re-identified after occlusion)');

console.log('\n=== 3. Rule engine: travelling from a foot-event sequence ===');
const re = new RuleEngine({ cfg: getRuleset('FIBA'), model: m });
const fe = [['plant', 'L', 0.9], ['lift', 'R', 0.95], ['plant', 'R', 1.25], ['lift', 'L', 1.35], ['plant', 'L', 1.6], ['lift', 'R', 1.7], ['plant', 'R', 1.95]];
re.addFootEvents(fe.map(([type, foot, t]) => ({ player: 'P7', cam: 'cam1', primary: true, type, foot, t, q: 0.85 })));
re.update(1.0, [{ type: 'gather', t: 1.0, player: 'P7', team: 0, kind: 'catch', fromDribble: true }], { controller: 'P7' }, [{ id: 'P7', speed: 3 }], { possConfidence: 0.8 });
const al = re.update(2.0, [], { controller: 'P7' }, [{ id: 'P7', speed: 3 }], { possConfidence: 0.8 });
for (const a of al) console.log(`${a.label} | player ${a.players} | evidence score ${a.confidence} | status ${a.status.toUpperCase()}\n  ` + a.reasons.join('\n  '));
