// End-to-end tests in headless Chromium: real WebRTC between a "phone" page and the dashboard page
// (fake camera device), reconnection, multi-phone, real-photo detection, court calibration via the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lookAtCamera, renderCourt } from '../helpers/synth.js';
import { writeY4M } from '../helpers/y4m.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(import.meta.dirname, '../..'), PORT = 8700 + Math.floor(Math.random() * 200), BASE = `http://localhost:${PORT}`;
let server;
const FAKE = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

test.before(async () => {
  server = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: PORT, DISABLE_HTTPS: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')) }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/info')).ok) return; } catch { } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => server?.kill());

const waitCode = async p => { await p.waitForFunction(() => /^\d{6}$/.test(document.getElementById('pairCode').textContent), null, { timeout: 15000 }); return p.textContent('#pairCode'); };
const liveCams = p => p.evaluate(() => [...courtside.cm.cams.values()].filter(c => c.state === 'live' && c.video.videoWidth > 0).map(c => c.id));
const waitLive = (p, n = 1) => p.waitForFunction(n => [...courtside.cm.cams.values()].filter(c => c.state === 'live' && c.video.videoWidth > 0).length >= n, n, { timeout: 20000 });
const step = async (name, task) => { try { return await task(); } catch (err) { throw new Error(`E2E step failed (${name}): ${err.message}`, { cause: err }); } };

test('pairing by QR link and by code, live WebRTC video, phone + dashboard reconnection', async () => {
  const b = await chromium.launch({ args: FAKE }); const ctx = await b.newContext({ permissions: ['camera'] });
  try {
    const dash = await ctx.newPage(); await dash.goto(BASE); const code = await waitCode(dash);
    const qrUrl = await dash.textContent('#pairUrl'); assert.match(qrUrl, /camera\.html\?m=.+&k=.+/);
    assert.match(await dash.innerHTML('#qr'), /<img/);
    // phone 1 via QR link (rewritten to this test server's origin)
    const p1 = await ctx.newPage(); await p1.goto(BASE + '/camera.html' + new URL(qrUrl).search); await p1.fill('#label', 'Phone A'); await p1.click('#join');
    await p1.waitForFunction(() => document.getElementById('state').textContent === 'LIVE', null, { timeout: 20000 });
    await waitLive(dash, 1);
    // phone 2 via 6-digit code
    const p2 = await ctx.newPage(); await p2.goto(BASE + '/camera.html'); await p2.fill('#code', code); await p2.click('#join');
    await waitLive(dash, 2); const ids = await liveCams(dash); assert.equal(ids.length, 2);
    assert.equal(await dash.locator('.camera-card').count(), 2);
    // frames really flow: video time advances on the dashboard
    const t1 = await dash.evaluate(() => [...courtside.cm.cams.values()][0].video.currentTime); await dash.waitForTimeout(1000);
    assert.ok(await dash.evaluate(() => [...courtside.cm.cams.values()][0].video.currentTime) > t1);
    // phone A reloads: same camera id comes back live (token reconnection)
    const before = await p1.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([k]) => k.startsWith('cs-cam-'))[1]).cameraId);
    console.log('[reconnection] phone reload');
    await step('phone reload', async () => { await p1.reload(); await p1.click('#join'); await p1.waitForFunction(() => document.getElementById('state').textContent === 'LIVE', null, { timeout: 20000 }); });
    const after = await p1.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([k]) => k.startsWith('cs-cam-'))[1]).cameraId);
    assert.equal(after, before); await waitLive(dash, 2); assert.equal(await dash.locator('.camera-card').count(), 2, 'no duplicate card');
    // dashboard reloads: host token reconnection, both phones re-offer automatically
    console.log('[reconnection] dashboard reload');
    await step('dashboard reload', async () => { await dash.reload(); assert.equal(await waitCode(dash), code); await waitLive(dash, 2); });
    // phone goes away: dashboard shows reconnecting
    console.log('[reconnection] phone close');
    await step('phone close', async () => { await p2.close(); await dash.waitForFunction(() => [...courtside.cm.cams.values()].some(c => c.state === 'reconnecting' || c.state === 'offline'), null, { timeout: 20000 }); });
  } finally { await b.close(); }
});

test('detectors on a real photograph (YOLO11n persons + MediaPipe poses)', async t => {
  const img = path.join(ROOT, 'tests/fixtures/bus.jpg');
  if (!fs.existsSync(img)) { try { const r = await fetch('https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/bus.jpg'); fs.writeFileSync(img, Buffer.from(await r.arrayBuffer())); } catch { return t.skip('no network for test image'); } }
  if (!fs.existsSync(path.join(ROOT, 'public/models/yolo11n.onnx'))) return t.skip('run npm run models');
  const b = await chromium.launch();
  try {
    const p = await b.newPage(); await p.route('**/fixture.jpg', r => r.fulfill({ body: fs.readFileSync(img), contentType: 'image/jpeg' }));
    await p.goto(BASE + '/camera.html');
    const r = await p.evaluate(async () => {
      const { PersonBallDetector, PoseEstimator } = await import('/js/app/detectors.js');
      const im = new Image(); im.src = '/fixture.jpg'; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
      const d = new PersonBallDetector(); await d.load('yolo'); const o = await d.detect(c); const pe = new PoseEstimator(); await pe.load();
      const cs = new PersonBallDetector(); await cs.load('coco'); const oc = await cs.detect(c);
      return { kind: d.kind, cocoKind: cs.kind, cocoPersons: oc.persons.filter(p => p.score > 0.5).length, persons: o.persons.filter(p => p.score > 0.5).length, poses: o.persons.filter(p => p.score > 0.5).map(p => pe.detectCrop(c, p.bbox)).filter(Boolean).length };
    });
    // bus.jpg contains 4 people (3 fully visible, 1 cut at the edge)
    assert.equal(r.kind, 'YOLO11n'); assert.equal(r.cocoKind, 'COCO-SSD'); assert.ok(r.cocoPersons >= 2, 'COCO-SSD persons ' + r.cocoPersons); // measured: COCO-SSD lite finds 2 of the 3 clear people at >0.5 (YOLO: 3) assert.ok(r.persons >= 3, JSON.stringify(r)); assert.equal(r.poses, r.persons);
  } finally { await b.close(); }
});

test('court auto-calibration through the dashboard UI on a (synthetic) court video feed', async () => {
  const y4m = path.join(ROOT, 'tests/fixtures/court.y4m');
  const cam = lookAtCamera({ eye: [2, -13, 7], target: [8, 0, 0], f: 1000, width: 1280, height: 720 });
  if (!fs.existsSync(y4m)) { fs.mkdirSync(path.dirname(y4m), { recursive: true }); const f = renderCourt(cam, { seed: 4 }).data; writeY4M(y4m, [f, f], 1280, 720); }
  const b = await chromium.launch({ args: [...FAKE, '--use-file-for-fake-video-capture=' + y4m] });
  try {
    const dash = await (await b.newContext({ permissions: ['camera'] })).newPage(); await dash.goto(BASE); await waitCode(dash);
    await dash.click('#addLocal'); await waitLive(dash, 1); await dash.waitForTimeout(500);
    await dash.click('.act-cal'); await dash.click('#calibAuto');
    await dash.waitForFunction(() => /Court found|failed/.test(document.getElementById('calibMsg').textContent), null, { timeout: 30000 });
    assert.match(await dash.textContent('#calibMsg'), /Court found/);
    await dash.click('#calibSave'); await dash.waitForFunction(() => /calibrated/.test(document.getElementById('timeline').textContent), null, { timeout: 10000 });
    const res = await dash.evaluate(() => { const c = courtside.analyzer.camera('local1').calib; return { H: c.Hc2i, w: c.width, rel: c.camModel.reliable, h: c.camModel.centre[2] }; });
    // compare with ground truth in the analysis resolution (960 px wide), allowing the court's symmetries
    const s = res.w / 1280, apply = (H, [x, y]) => { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]; };
    const err = Math.min(...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, bb]) => { let e = 0, n = 0; for (const p of [[8.2, 2.45], [14, -7.5], [5.675, 0], [10, -4]]) { const q = apply(res.H, [a * p[0], bb * p[1]]), g = apply(cam.H, p); e += Math.hypot(q[0] - g[0] * s, q[1] - g[1] * s); n++; } return e / n; }));
    assert.ok(err < 4, 'calibration error ' + err.toFixed(2) + ' px'); assert.ok(res.rel && Math.abs(res.h - 7) < 0.8, 'camera height ' + res.h);
    assert.equal(await dash.evaluate(() => document.getElementById('calCount').textContent), '1 / 1');
  } finally { await b.close(); }
});
