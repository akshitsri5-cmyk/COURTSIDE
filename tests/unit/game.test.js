// Possession, actions, rule engine, fouls (synthetic multi-camera plays) + score, clock, sync, health, alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAnalyzer } from '../../public/js/core/game-analyzer.js';
import { getRuleset } from '../../public/js/core/rules/rulesets.js';
import { run } from '../helpers/scenario.js';
import * as plays from '../helpers/plays.js';
import { RuleEngine } from '../../public/js/core/rule-engine.js';
import { CourtModel } from '../../public/js/core/court-model.js';
import { GameClock } from '../../public/js/core/game-clock.js';
import { ScoreManager } from '../../public/js/core/score-manager.js';
import { AlertManager } from '../../public/js/core/alert-manager.js';
import { ClockSync, FrameTimestamper, detectFlash, flashOffsets } from '../../public/js/core/camera-sync.js';
import { CameraHealthMonitor } from '../../public/js/core/camera-health.js';
import { seededRng } from '../helpers/synth.js';

const FIBA = getRuleset('FIBA');
const play = (sc, t1) => run(new GameAnalyzer({ ruleset: FIBA }), sc, { t1, fps: 30 });
const types = r => r.actions.map(a => a.type);

test('possession + dribble + pass + catch detected in order', () => {
  const r = play(plays.dribblePassPlay(), 4), T = types(r);
  assert.ok(T.includes('dribble_start')); assert.ok(T.filter(x => x === 'bounce').length >= 3, 'bounces');
  const g = r.actions.find(a => a.type === 'gather' && a.kind === 'dribble_end'), p = r.actions.find(a => a.type === 'pass'), c = r.actions.find(a => a.type === 'catch');
  assert.ok(g && p && c && g.t < p.t && p.t <= c.t); assert.notEqual(p.from, p.to);
  assert.equal(r.alerts.length, 0, 'legal play must not raise alerts');
  const mid = r.states.find(s => s.t > 1.0 && s.t < 1.1); assert.ok(mid.poss.controller, 'controller during dribble');
});

test('double dribble flagged; reasons cite FIBA Art. 24', () => {
  const r = play(plays.dribblePassPlay({ doubleDribble: true }), 4), a = r.alerts.filter(x => x.type === 'double_dribble');
  assert.equal(a.length, 1); assert.match(a[0].reasons[0], /24/); assert.equal(a[0].decision, 'pending');
});

test('travelling: 3 steps after the gather is flagged; a legal 2-step play is not', () => {
  const bad = play(plays.catchAndStepPlay({ steps: 3 }).sc, 3.5).alerts.filter(a => a.type === 'travelling');
  assert.equal(bad.length, 1); assert.equal(bad[0].evidence.rule, 'steps');
  assert.equal(play(plays.catchAndStepPlay({ steps: 2 }).sc, 3.5).alerts.filter(a => a.type === 'travelling').length, 0);
});

test('travelling rule unit cases: pivot foot re-plant, jump-and-land, walking double-support is not a stop', () => {
  const re = new RuleEngine({ cfg: FIBA, model: new CourtModel() }), P = 'P1';
  const ev = (list) => re.addFootEvents(list.map(([type, foot, t]) => ({ player: P, cam: 'c', primary: true, type, foot, t, q: 0.9 })));
  ev([['plant', 'L', 0.5], ['plant', 'R', 0.5], ['lift', 'L', 1.2], ['plant', 'L', 1.4], ['lift', 'R', 1.6], ['plant', 'R', 1.8]]);
  re.update(1.0, [{ type: 'gather', t: 1.0, player: P, team: 0, kind: 'catch' }], {}, [{ id: P, speed: 0 }]);
  const a = re.update(2.0, [], { controller: P }, [{ id: P, speed: 0 }]);
  assert.equal(a[0]?.evidence.rule, 'pivot');
  const re2 = new RuleEngine({ cfg: FIBA, model: new CourtModel() });
  re2.addFootEvents([['plant', 'L', 0.9], ['lift', 'R', 0.9], ['jump', null, 1.2], ['land', null, 1.6]].map(([type, foot, t]) => ({ player: P, cam: 'c', primary: true, type, foot, t, q: 0.9, feet: 'both' })));
  re2.update(1.0, [{ type: 'gather', t: 1.0, player: P, team: 0, kind: 'catch' }], {}, [{ id: P, speed: 3 }]);
  assert.equal(re2.update(1.7, [], { controller: P }, [{ id: P, speed: 1 }])[0]?.evidence.rule, 'jump');
});

test('ball out of bounds flagged once; ball landing inside is not', () => {
  const out = play(plays.looseBallPlay([9, 8.2]), 2).alerts.filter(a => a.type === 'ball_out_of_bounds');
  assert.equal(out.length, 1); assert.ok(out[0].evidence.margin < 0);
  assert.equal(play(plays.looseBallPlay([9, 5.5]), 2).alerts.filter(a => a.type === 'ball_out_of_bounds').length, 0);
});

test('player with the ball stepping on the boundary line is flagged', () => {
  const re = new RuleEngine({ cfg: FIBA, model: new CourtModel() });
  re.addFootEvents([{ player: 'P1', cam: 'c', primary: true, type: 'plant', foot: 'L', t: 1.0, court: [5, 7.49], q: 0.9, sigma: 0.05 }]);
  const a = re.update(1.1, [], { controller: 'P1', team: 0 }, [{ id: 'P1', pos: [5, 7.3] }]);
  assert.equal(a[0]?.type, 'player_out_of_bounds');
});

test('shots: made three-pointer and missed two-pointer classified with 3-D evidence', () => {
  const m = play(plays.jumpShotPlay({ spot: [4.8, 0.5] }), 4).actions, x = play(plays.jumpShotPlay({ spot: [7.5, 1], made: false }), 4).actions;
  const rm = m.find(a => a.type === 'shot_result'), rx = x.find(a => a.type === 'shot_result');
  assert.equal(rm.result, 'made'); assert.equal(rm.points, 3); assert.ok(rm.confidence >= 0.85);
  assert.equal(rx.result, 'missed'); assert.equal(rx.points, 2);
  assert.equal(m.filter(a => a.type === 'shot').length, 1, 'one shot');
});

test('fouls: charge vs block classified; depth overlap in one view is NOT a foul', () => {
  const c = play(plays.contactPlay('charge').sc, 4).alerts, b = play(plays.contactPlay('block').sc, 4).alerts, n = play(plays.contactPlay('none').sc, 4).alerts;
  assert.deepEqual(c.map(a => a.type), ['charging_foul']); assert.deepEqual(b.map(a => a.type), ['blocking_foul']);
  assert.equal(n.length, 0);
  for (const a of [...c, ...b]) { assert.equal(a.decision, 'pending'); assert.ok(a.reasons.length >= 3 && a.cams.length === 2); }
});

test('score manager: auto-apply confident basket once, pending when uncertain, undo', () => {
  const s = new ScoreManager({ autoMinConfidence: 0.85 });
  assert.equal(s.handleShotResult({ shotId: 'S1', result: 'made', confidence: 0.92, points: 3, team: 0, t: 10 }).action, 'applied');
  assert.equal(s.handleShotResult({ shotId: 'S1', result: 'made', confidence: 0.92, points: 3, team: 0, t: 10 }).action, 'duplicate');
  assert.equal(s.handleShotResult({ shotId: 'S2', result: 'made', confidence: 0.9, points: 2, team: 0, t: 10.5 }).action, 'duplicate', 'same team within 1.5 s');
  assert.equal(s.score.home, 3);
  assert.equal(s.handleShotResult({ shotId: 'S3', result: 'made', confidence: 0.6, points: 2, team: 1, t: 30 }).action, 'pending');
  assert.equal(s.handleShotResult({ shotId: 'S4', result: 'made', confidence: 0.95, points: 3, pointsUncertain: true, team: 1, t: 50 }).action, 'pending');
  s.resolvePending('S3', { points: 2 }); s.resolvePending('S4', { points: 0 }); assert.equal(s.score.away, 2);
  s.add('away', 1); s.undo(); assert.equal(s.score.away, 2);
});

test('game clock: drift-free timing, tenths, period end, shot clock, FIBA last-2-min stop', () => {
  let now = 0; const c = new GameClock(FIBA.timing, () => now), ev = []; c.on(e => ev.push(e.type));
  c.start(); now = 123456.7; assert.equal(c.remainingMs(), 600000 - 123456.7);
  c.pause(); now += 50000; assert.equal(c.remainingMs(), 600000 - 123456.7, 'paused');
  c.start(); now += 24000; c.tick(); assert.ok(ev.includes('shot_clock_expired'));
  c.setRemaining(59500); assert.equal(GameClock.format(c.remainingMs()), '59.5');
  now += 59500; c.tick(); assert.ok(ev.includes('period_end')); assert.equal(c.running, false); assert.equal(c.remainingMs(), 0);
  c.period = 4; c.setRemaining(100000); c.start(); c.onMadeBasket(); assert.equal(c.running, false, 'stopped after made basket in last 2:00 of Q4');
  c.setRemaining(300000); c.start(); c.onMadeBasket(); assert.equal(c.running, true);
  c.onPossessionChange(1, 0, { offensiveReboundAfterRim: true }); assert.equal(c.shotRemainingMs(), 14000);
});

test('camera sync: clock offset from noisy round trips; frame timestamps; flash alignment', () => {
  const rng = seededRng(1), cs = new ClockSync(), trueOff = 5234.5;
  for (let i = 0; i < 20; i++) { const t0 = i * 1000, up = 5 + rng() * 40, down = 5 + rng() * 40; cs.addSample(t0, t0 + up + trueOff, t0 + up + down); }
  assert.ok(Math.abs(cs.offset - trueOff) < 8, 'offset ' + cs.offset);
  const ft = new FrameTimestamper(l => l + 100); ft.setStats('c1', { rttMs: 40 });
  assert.equal(ft.stamp('c1', { captureTime: 1000 }).serverMs, 1100); assert.equal(ft.stamp('c1', { receiveTime: 1000 }).serverMs, 1080);
  const series = off => Array.from({ length: 30 }, (_, i) => ({ t: i * 33.3 + off, y: i * 33.3 + off > 500 ? 200 : 60 }));
  const f1 = detectFlash(series(0)), f2 = detectFlash(series(12));
  assert.ok(Math.abs(f1 - 500) < 34 && Math.abs(flashOffsets({ a: f1, b: f2 }, 'a').b - 0) < 34);
});

test('camera health: freeze, obstruction, camera movement, accelerometer bump', () => {
  const W = 64, H = 36, img = (dx = 0) => { const g = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = ((x - dx) % 10 < 2 || y % 9 < 2) ? 220 : 90; return g; };
  const h = new CameraHealthMonitor(); h.setReference(img(), W, H);
  for (let i = 0; i < 20; i++) h.noteFrame(i / 15);
  assert.equal(h.check(20 / 15, img(), W, H).level, 'ok');
  assert.ok(h.check(20 / 15, img(4), W, H).issues.some(i => i.code === 'moved'));
  assert.ok(h.check(20 / 15, new Float32Array(W * H).fill(10), W, H).issues.some(i => i.code === 'obstructed'));
  assert.ok(h.check(5, img(), W, H).issues.some(i => i.code === 'frozen'));
  h.noteDeviceMotion(5, 3); assert.ok(h.check(5.1).issues.some(i => i.code === 'bumped'));
});

test('alert manager: dedupe, referee decisions', () => {
  const am = new AlertManager(); const a = am.add({ id: 'A1', type: 'travelling', t: 1, players: ['P1'], confidence: 0.5, decision: 'pending' });
  am.add({ id: 'A2', type: 'travelling', t: 1.5, players: ['P1'], confidence: 0.7, decision: 'pending' });
  assert.equal(am.alerts.length, 1); assert.equal(a.confidence, 0.7);
  am.decide('A1', 'confirmed', 'clear travel'); assert.equal(am.get('A1').decision, 'confirmed'); assert.throws(() => am.decide('A1', 'bogus'));
});
