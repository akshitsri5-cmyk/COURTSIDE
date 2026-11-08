// Player tracking IDs, multi-camera fusion/re-identification, ball detection and tracking (synthetic).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerTracker } from '../../public/js/core/player-tracking.js';
import { BallTracker, findBallCandidates, fitBallistic } from '../../public/js/core/ball-tracking.js';
import { embed, appearanceDistance, clusterTeams } from '../../public/js/core/appearance.js';
import { GameAnalyzer, attachPoses } from '../../public/js/core/game-analyzer.js';
import { getRuleset } from '../../public/js/core/rules/rulesets.js';
import { run, Scenario, STANDARD_CAMS } from '../helpers/scenario.js';
import { walker } from '../helpers/plays.js';
import { TEAM_EMB } from '../helpers/scenario.js';

test('tracker keeps IDs when two players cross and one is fully occluded', () => {
  const tr = new PlayerTracker(), seen = { A: new Set(), B: new Set() };
  for (let k = 0; k < 45; k++) {
    const t = k / 15, xa = 100 + k * 12, xb = 640 - k * 12, dets = [{ bbox: [xa, 200, 50, 150], score: 0.9, emb: TEAM_EMB[0], gt: 'A' }];
    if (Math.abs(xa - xb) > 30) dets.push({ bbox: [xb, 205, 50, 150], score: 0.9, emb: TEAM_EMB[1], gt: 'B' });
    tr.update(dets, t); for (const d of dets) { const m = tr.active().find(x => x.det === d); if (m) seen[d.gt].add(m.id); }
  }
  assert.equal(seen.A.size, 1); assert.equal(seen.B.size, 1); assert.notDeepEqual([...seen.A], [...seen.B]);
});

test('tracker re-identifies a player after a 1.5 s disappearance (lost-track gallery)', () => {
  const tr = new PlayerTracker(), ids = new Set();
  for (let k = 0; k < 75; k++) { const t = k / 15; if (t > 1.5 && t < 3.0) { tr.update([], t); continue; } const d = { bbox: [300 + k * 2, 200, 50, 150], score: 0.9, emb: TEAM_EMB[0] }; tr.update([d], t); const m = tr.active().find(x => x.det === d); if (m) ids.add(m.id); }
  assert.equal(ids.size, 1, [...ids].join());
});

test('ByteTrack low-score stage keeps a partially occluded (low confidence) player', () => {
  const tr = new PlayerTracker(); let id = null;
  for (let k = 0; k < 30; k++) { const d = { bbox: [200 + 3 * k, 100, 50, 150], score: k > 10 && k < 20 ? 0.3 : 0.9 }; tr.update([d], k / 15); const m = tr.active().find(x => x.det === d); assert.ok(k < 3 || m, 'tracked at frame ' + k); if (m) { if (id && k >= 3) assert.equal(m.id, id); id = m.id; } }
});

test('multi-camera fusion: one global ID per player across 2 cameras, ~cm position accuracy, teams clustered', () => {
  const sc = new Scenario({ cameras: STANDARD_CAMS })
    .addPlayer({ id: 'A', team: 0, state: walker([[0, [4, -3]], [4, [10, 3]]]) })
    .addPlayer({ id: 'B', team: 1, state: walker([[0, [4, 3]], [4, [10, -3]]]) })
    .addPlayer({ id: 'C', team: 0, state: walker([[0, [9, -5]], [4, [9, 5]]]) });
  const an = new GameAnalyzer({ ruleset: getRuleset('FIBA') }), r = run(an, sc, { t1: 4, fps: 15 });
  const map = {}; for (const e of r.gtMap) (map[e.gt] ||= new Set()).add(e.gid);
  for (const k of ['A', 'B', 'C']) assert.equal(map[k].size, 1, k + ' -> ' + [...map[k]]);
  assert.equal(new Set(Object.values(map).map(s => [...s][0])).size, 3, 'distinct IDs');
  const last = r.states.at(-1).players, find = id => last.find(p => p.id === [...map[id]][0]);
  assert.ok(Math.hypot(find('A').pos[0] - 10, find('A').pos[1] - 3) < 0.15);
  assert.equal(find('A').team, find('C').team); assert.notEqual(find('A').team, find('B').team);
});

test('cross-camera re-identification: player hidden from camera 1 keeps the same global ID', () => {
  const sc = new Scenario({ cameras: STANDARD_CAMS }).addPlayer({ id: 'A', team: 0, state: walker([[0, [5, -2]], [4, [9, 2]]]) }).addPlayer({ id: 'B', team: 1, state: walker([[0, [9, -4]], [4, [5, 4]]]) })
    .hide('cam1', 'A', 1.0, 2.5);
  const an = new GameAnalyzer({ ruleset: getRuleset('FIBA') }), r = run(an, sc, { t1: 4, fps: 15 });
  const ids = new Set(r.gtMap.filter(e => e.gt === 'A').map(e => e.gid)); assert.equal(ids.size, 1, [...ids].join());
});

test('colour ball candidates find an orange ball on a wooden floor', () => {
  const W = 320, H = 180, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[4 * i] = 200; data[4 * i + 1] = 170; data[4 * i + 2] = 120; data[4 * i + 3] = 255; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 150) ** 2 + (y - 90) ** 2 < 100) { const i = 4 * (y * W + x); data[i] = 220; data[i + 1] = 95; data[i + 2] = 30; }
  const c = findBallCandidates({ width: W, height: H, data }, { step: 1 });
  assert.ok(c.length >= 1); assert.ok(Math.hypot(c[0].x - 150, c[0].y - 90) < 3 && Math.abs(c[0].r - 10) < 3, JSON.stringify(c[0]));
});

test('ball tracker follows a fast parabola, coasts through occlusion and recovers', () => {
  const bt = new BallTracker(); let recovered = false;
  for (let k = 0; k < 40; k++) {
    const t = k / 30, x = 100 + 600 * t, y = 500 - 700 * t + 490 * t * t; // ~600 px/s
    const occluded = k >= 15 && k < 20;
    const e = bt.update(occluded ? [] : [{ x, y, r: 9, score: 0.7, source: 'model' }], t);
    if (occluded) { assert.equal(e.state, 'occluded'); assert.ok(Math.hypot(e.u - x, e.v - y) < 25, 'prediction during occlusion off by ' + Math.hypot(e.u - x, e.v - y).toFixed(1)); }
    if (k === 21) { recovered = e.state === 'tracking' && Math.hypot(e.u - x, e.v - y) < 5; }
  }
  assert.ok(recovered);
});

test('ball tracker detects bounces (vertical reversals) of a dribble', () => {
  const bt = new BallTracker();
  for (let k = 0; k < 60; k++) { const t = k / 30, y = 300 + 60 * Math.abs(Math.sin(2 * Math.PI * t)); bt.update([{ x: 200, y: 360 - (y - 300), r: 8, score: 0.8, source: 'model' }], t); }
  // floor (max y) reached at t = 0, 0.5, 1.0, 1.5 -> 3 detectable bounces after warm-up
  assert.ok(bt.events.length >= 3, 'bounces ' + bt.events.map(e => e.t.toFixed(2)));
});

test('ballistic 3-D trajectory fit', () => {
  const pts = []; for (let i = 0; i < 10; i++) { const t = i / 30; pts.push({ t, X: [5 + 6 * t, 0.5, 2.4 + 7 * t - 4.905 * t * t] }); }
  const f = fitBallistic(pts); assert.ok(f.rms < 1e-6); assert.ok(Math.abs(f.V[2] - 7) < 1e-6);
});

test('appearance embedding separates jersey colours and clusters teams', () => {
  const mk = (r, g, b) => { const W = 40, H = 100, d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { d[4 * i] = r; d[4 * i + 1] = g; d[4 * i + 2] = b; d[4 * i + 3] = 255; } return embed({ width: W, height: H, data: d }, [0, 0, W, H]); };
  const red1 = mk(200, 30, 30), red2 = mk(180, 40, 35), blue = mk(30, 40, 200), white = mk(240, 240, 240);
  assert.ok(appearanceDistance(red1, red2) < 0.2); assert.ok(appearanceDistance(red1, blue) > 0.8); assert.ok(appearanceDistance(white, blue) > 0.8);
  const { labels } = clusterTeams([red1, blue, red2, mk(40, 30, 190)]); assert.equal(labels[0], labels[2]); assert.equal(labels[1], labels[3]); assert.notEqual(labels[0], labels[1]);
});

test('pose skeletons are attached to the right person detection', () => {
  const pose = (x, y) => Array.from({ length: 33 }, (_, i) => ({ x: x + (i % 3) * 5, y: y + i * 4, v: 0.9 }));
  const dets = [{ bbox: [100, 100, 60, 160], score: 0.9 }, { bbox: [300, 100, 60, 160], score: 0.9 }];
  const out = attachPoses(dets, [pose(310, 110), pose(110, 110)]);
  assert.equal(out[0].pose[0].x, 110); assert.equal(out[1].pose[0].x, 310);
});
