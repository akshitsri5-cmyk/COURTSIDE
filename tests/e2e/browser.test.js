// End-to-end tests in headless Chromium: real WebRTC between a "phone" page and the dashboard page
// (fake camera device), reconnection, multi-phone, real-photo detection, court calibration via the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lookAtCamera, renderCourt } from '../helpers/synth.js';
import { writeY4M } from '../helpers/y4m.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(import.meta.dirname, '../..'), PORT = 8700 + Math.floor(Math.random() * 200), BASE = `http://localhost:${PORT}`;
let server, ntfy; const pushes = [], NTFY_PORT = PORT + 1000;
const FAKE = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

test.before(async () => {
  ntfy = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { pushes.push({ path: q.url, title: q.headers.title, body: b }); r.end('ok'); }); }); await new Promise(r => ntfy.listen(NTFY_PORT, r));
  server = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, NTFY_URL: `http://127.0.0.1:${NTFY_PORT}`, HTTP_PORT: PORT, DISABLE_HTTPS: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')) }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/info')).ok) return; } catch { } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); ntfy?.close(); });

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
    // phone 2 joins from the MAIN page by typing the code (no QR)
    const phoneCtx = await b.newContext({ permissions: ['camera'] }); // a separate device
    const p2 = await phoneCtx.newPage(); await p2.goto(BASE); await p2.click('#joinTop'); await p2.fill('#joinCode', code); await p2.click('#joinBtn');
    await p2.waitForURL(/camera\.html\?code=\d{6}/); assert.equal(await p2.inputValue('#code'), code); await p2.click('#join');
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

test('automatic half-court calibration (no clicks) on a (synthetic) court video feed', async () => {
  const y4m = path.join(ROOT, 'tests/fixtures/court.y4m');
  const cam = lookAtCamera({ eye: [2, -13, 7], target: [8, 0, 0], f: 1000, width: 1280, height: 720 });
  if (!fs.existsSync(y4m)) { fs.mkdirSync(path.dirname(y4m), { recursive: true }); const f = renderCourt(cam, { seed: 4 }).data; writeY4M(y4m, [f, f], 1280, 720); }
  const b = await chromium.launch({ args: [...FAKE, '--use-file-for-fake-video-capture=' + y4m] });
  try {
    const dash = await (await b.newContext({ permissions: ['camera'] })).newPage(); await dash.goto(BASE); await waitCode(dash);
    await dash.click('#addLocal'); await waitLive(dash, 1); await dash.waitForTimeout(500);
    // no clicks: the court must be found automatically
    await dash.waitForFunction(() => /court found automatically/.test(document.getElementById('timeline').textContent), null, { timeout: 60000 });
    const res = await dash.evaluate(() => { const c = courtside.analyzer.camera('local1').calib; return { H: c.Hc2i, w: c.width, rel: c.camModel.reliable, h: c.camModel.centre[2] }; });
    // compare with ground truth in the analysis resolution (960 px wide), allowing the court's symmetries
    const s = res.w / 1280, apply = (H, [x, y]) => { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]; };
    const err = Math.min(...[[1, 1]].map(([a, bb]) => /* half-court canonical frame: NO symmetry tolerance */ { let e = 0, n = 0; for (const p of [[8.2, 2.45], [14, -7.5], [5.675, 0], [10, -4]]) { const q = apply(res.H, [a * p[0], bb * p[1]]), g = apply(cam.H, p); e += Math.hypot(q[0] - g[0] * s, q[1] - g[1] * s); n++; } return e / n; }));
    assert.ok(err < 4, 'calibration error ' + err.toFixed(2) + ' px'); assert.ok(res.rel && Math.abs(res.h - 7) < 0.8, 'camera height ' + res.h);
    await dash.waitForFunction(() => document.getElementById('calCount').textContent === '1 / 1', null, { timeout: 5000 });
    // the analysis pipeline (default worker detector) must actually process frames without errors
    await dash.waitForFunction(() => [...courtside.S.pipelines.values()].every(p => p.frameN > 0), null, { timeout: 90000 });
    assert.deepEqual(await dash.evaluate(() => [...courtside.S.pipelines.values()].map(p => p.error || null)), [null]);
  } finally { await b.close(); }
});

test('previous games: recording + result saved in the app, watched in-app, downloaded, survives reload, deleted', async () => {
  const b = await chromium.launch({ args: FAKE });
  try {
    const ctx = await b.newContext({ permissions: ['camera'], acceptDownloads: true });
    const dash = await ctx.newPage(); await dash.goto(BASE); await waitCode(dash);
    await dash.click('#addLocal'); await waitLive(dash, 1);
    await dash.fill('#locText', 'Test court, Noida'); await dash.dispatchEvent('#locText', 'change');
    await dash.fill('#nameA', 'Akshit'); await dash.dispatchEvent('#nameA', 'change');
    await dash.click('#recBtn'); await dash.waitForFunction(() => /REC/.test(document.getElementById('recStatus').textContent), null, { timeout: 5000 });
    await dash.locator('[data-team="home"][data-points="2"]').click(); await dash.waitForTimeout(12000); // > one 10 s chunk + remainder
    await dash.click('#recBtn'); await dash.waitForFunction(() => /saved in Previous games/.test(document.getElementById('recStatus').textContent), null, { timeout: 15000 });
    const row = dash.locator('#historyList [data-id]').first(); await row.waitFor({ timeout: 5000 });
    const txt = await row.textContent(); assert.match(txt, /AKSHIT vs/); assert.match(txt, /2–0/); assert.match(txt, /Test court, Noida/); assert.match(txt, /1 video/);
    await row.locator('.h-watch').click(); await dash.waitForFunction(() => { const v = document.getElementById('histVideo'); return !document.getElementById('videoModal').hidden && v.readyState >= 1; }, null, { timeout: 10000 });
    await dash.click('#histClose');
    const downloads = []; dash.on('download', d => downloads.push(d)); await row.locator('.h-dl').click(); await dash.waitForTimeout(1500);
    const video = downloads.find(d => d.suggestedFilename().endsWith('.webm')), info = downloads.find(d => d.suggestedFilename().endsWith('_match-info.json'));
    assert.ok(video && info, downloads.map(d => d.suggestedFilename()).join()); assert.ok(fs.statSync(await video.path()).size > 10000, 'video has data');
    const meta = JSON.parse(fs.readFileSync(await info.path(), 'utf8')); assert.equal(meta.location.text, 'Test court, Noida'); assert.equal(meta.finalScore.home, 2); assert.ok(meta.startedAt && meta.endedAt);
    await dash.reload(); await waitCode(dash); await dash.locator('#historyList [data-id]').first().waitFor({ timeout: 5000 }); // persisted
    dash.on('dialog', d => d.accept()); await dash.locator('#historyList .h-del').first().click();
    await dash.waitForFunction(() => !document.querySelector('#historyList [data-id]'), null, { timeout: 5000 });
  } finally { await b.close(); }
});

test('previous games: the result is saved automatically when a player wins (no recording needed)', async () => {
  const b = await chromium.launch();
  try {
    const dash = await (await b.newContext()).newPage(); await dash.goto(BASE); await waitCode(dash);
    for (let i = 0; i < 6; i++) await dash.locator('[data-team="away"][data-points="2"]').click(); // 12 >= 11
    await dash.waitForFunction(() => /0–12/.test(document.getElementById('historyList').textContent), null, { timeout: 8000 });
  } finally { await b.close(); }
});
test('Apple Watch: watch page shows live score/clock/calls (secret link) and calls are pushed to ntfy', async () => {
  const b = await chromium.launch();
  try {
    const dash = await (await b.newContext()).newPage(); await dash.goto(BASE); await waitCode(dash);
    await dash.fill('#ntfyTopic', 'courtside-testtopic'); await dash.dispatchEvent('#ntfyTopic', 'change');
    await dash.locator('[data-team="home"][data-points="2"]').click();
    await dash.evaluate(() => { const t = courtside.sig.serverTime() / 1000; courtside.addAlert({ id: 'W1', type: 'charging_foul', label: 'Charging foul', t, tStart: t - 2, tEnd: t, players: ['P1'], team: 0, confidence: 0.8, status: 'flagged', decision: 'pending', cams: ['cam1', 'cam2'], reasons: ['test'] }); });
    const url = await dash.textContent('#watchUrl'); assert.match(url, /\/watch\/.+\?k=.+/);
    await dash.waitForTimeout(2600);
    const w = await (await b.newContext({ viewport: { width: 198, height: 242 } })).newPage(); // Apple Watch-sized screen
    await w.goto(url.replace(/^https?:\/\/[^/]+/, BASE)); const html = await w.content();
    assert.match(html, /PLAYER A/); assert.match(html, />2</); assert.match(html, /Charging foul/); assert.match(html, /http-equiv="refresh"/);
    assert.equal(await w.evaluate(() => document.scripts.length), 0, 'no JavaScript needed on the watch');
    assert.equal((await fetch(url.replace(/^https?:\/\/[^/]+/, BASE).replace(/k=[^&]+/, 'k=wrong'))).status, 403, 'secret link required');
    await dash.waitForTimeout(500);
    assert.ok(pushes.some(p => p.path === '/courtside-testtopic' && /Charging foul/.test(p.title)), JSON.stringify(pushes));
  } finally { await b.close(); }
});

test('default detector: EfficientDet + pose in a background worker (real photo, page stays responsive)', async () => {
  const b = await chromium.launch();
  try {
    const p = await b.newPage(); await p.route('**/fixture.jpg', r => r.fulfill({ body: fs.readFileSync(path.join(ROOT, 'tests/fixtures/bus.jpg')), contentType: 'image/jpeg' }));
    await p.goto(BASE + '/camera.html');
    const r = await p.evaluate(async () => {
      const { WorkerVision } = await import('/js/app/detectors.js'); const im = new Image(); im.src = '/fixture.jpg'; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
      const d = new WorkerVision(); await d.load(); let ticks = 0, maxGap = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 20);
      const o = await d.detect(c, { pose: true }); clearInterval(iv);
      const ps = o.persons.filter(x => x.score > 0.5); return { status: d.status, persons: ps.length, withPose: ps.filter(x => x.pose).length, maxMainThreadGapMs: Math.round(maxGap) };
    });
    assert.ok(r.persons >= 3, JSON.stringify(r)); assert.ok(r.withPose >= r.persons - 1, 'pose for all fully visible people (one is cut off at the photo edge): ' + JSON.stringify(r));
    assert.ok(r.maxMainThreadGapMs < 500, 'main thread stayed responsive during detection: ' + JSON.stringify(r));
  } finally { await b.close(); }
});

test('phone dashcam: "Record on this phone" saves a full-quality file on the phone', async () => {
  const b = await chromium.launch({ args: FAKE });
  try {
    const ctx = await b.newContext({ permissions: ['camera'], acceptDownloads: true });
    const dash = await ctx.newPage(); await dash.goto(BASE); const code = await waitCode(dash);
    const ph = await (await b.newContext({ permissions: ['camera'], acceptDownloads: true })).newPage(); await ph.goto(BASE + '/camera.html?code=' + code); await ph.click('#join');
    await ph.waitForFunction(() => document.getElementById('state').textContent === 'LIVE', null, { timeout: 30000 });
    await ph.click('#dashcam'); await ph.waitForTimeout(3000);
    const [dl] = await Promise.all([ph.waitForEvent('download'), ph.click('#dashcam')]);
    assert.match(dl.suggestedFilename(), /^COURTSIDE_.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.(webm|mp4)$/); assert.ok(fs.statSync(await dl.path()).size > 10000);
  } finally { await b.close(); }
});

test('score agent: rim found automatically (no clicks), a ball dropping through the net is scored', async () => {
  const y4m = path.join(ROOT, 'tests/fixtures/hoop.y4m'), W = 640, H = 360;
  if (!fs.existsSync(y4m)) {
    const frames = [];
    for (let k = 0; k < 90; k++) {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = 4 * (y * W + x), sky = y < 150; d[i] = sky ? 128 : 160; d[i + 1] = sky ? 158 : 128; d[i + 2] = sky ? 178 : 98; d[i + 3] = 255; }
      const px = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return; const i = 4 * (y * W + x); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; };
      for (let y = 40; y < 105; y++) for (let x = 300; x < 400; x++) px(x, y, [235, 235, 235]);
      for (let y = 70; y < 100; y++) for (let x = 335; x < 365; x++) if (y === 70 || y === 99 || x === 335 || x === 364) px(x, y, [200, 40, 40]);
      for (let a = 0; a < 2 * Math.PI; a += 0.005) for (let t = -1; t <= 1; t++) px(350 + 26 * Math.cos(a), 110 + t + 5 * Math.sin(a), [220, 80, 30]);
      const swish = k >= 40 && k <= 50;
      for (let y = 116; y < 150; y++) for (let x = 330; x < 371; x++) if (((x + y + (swish ? k * 2 : 0)) % 5 === 0) || ((x - y) % 5 === 0)) px(x, y, [245, 245, 245]);
      const by = 20 + (k - 30) * 11; if (k >= 30 && k <= 46) for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) px(350 + x, by + y, [185, 185, 178]); // grey (dirty white) ball
      frames.push(d);
    }
    writeY4M(y4m, frames, W, H);
  }
  const b = await chromium.launch({ args: [...FAKE, '--use-file-for-fake-video-capture=' + y4m] });
  try {
    const dash = await (await b.newContext({ permissions: ['camera'] })).newPage(); await dash.goto(BASE); await waitCode(dash);
    await dash.click('#addLocal'); await waitLive(dash, 1);
    await dash.waitForFunction(() => /rim found automatically/.test(document.getElementById('timeline').textContent), null, { timeout: 30000 });
    const rim = await dash.evaluate(() => courtside.S.rims.local1); assert.ok(Math.hypot(rim.u - 525, rim.v - 165) < 12, 'rim position (analysis px): ' + JSON.stringify(rim));
    await dash.waitForFunction(() => /Basket detected at the rim/.test(document.getElementById('timeline').textContent), null, { timeout: 20000 });
    const r = await dash.evaluate(() => ({ score: courtside.score.score, pending: courtside.score.pending.length }));
    assert.ok(r.score.home + r.score.away > 0 || r.pending > 0, JSON.stringify(r));
  } finally { await b.close(); }
});
