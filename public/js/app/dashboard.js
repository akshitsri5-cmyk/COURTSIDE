// COURTSIDE referee dashboard: wires signalling, cameras, analysis, rules, scoring, clock and review UI.
import { SignalClient } from './signal-client.js';
import { CameraManager } from './camera-manager.js';
import { CameraPipeline } from './pipeline.js';
import { PersonBallDetector } from './detectors.js';
import { GameAnalyzer } from '../core/game-analyzer.js';
import { CourtModel } from '../core/court-model.js';
import { getRuleset } from '../core/rules/rulesets.js';
import { GameClock } from '../core/game-clock.js';
import { ScoreManager } from '../core/score-manager.js';
import { AlertManager } from '../core/alert-manager.js';
import { MatchRecorder } from '../core/match-recorder.js';
import { FrameTimestamper, detectFlash, flashOffsets } from '../core/camera-sync.js';
import { makeAlert } from '../core/rule-engine.js';
import { applyH, hDepth } from '../core/homography.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };

// ---------- state ----------
const S = { match: store.get('cs-host'), pipelines: new Map(), cards: new Map(), selectedAlert: null, teamSwap: false, info: null, settings: store.get('cs-settings', { fps: 10, pose: true, ruleset: 'FIBA' }) };
let ruleset = getRuleset(S.settings.ruleset), model = new CourtModel(ruleset.court);
const clock = new GameClock(ruleset.timing);
const score = new ScoreManager({ autoMinConfidence: ruleset.analysis.autoScoreMinConfidence });
const alerts = new AlertManager();
let recorder = new MatchRecorder(S.match?.matchId || 'local');
let analyzer = new GameAnalyzer({ ruleset, model, clock });
const detector = new PersonBallDetector();
const sig = new SignalClient(() => ({ type: 'hello', role: 'host', matchId: S.match?.matchId, hostToken: S.match?.hostToken, name: $('matchName').value || 'Match' }));
const serverNowMs = () => sig.serverTime();
const timestamper = new FrameTimestamper(local => local + performance.timeOrigin + sig.clock.offset);
const cm = new CameraManager(sig, []);
$('fpsSel').value = String(S.settings.fps); $('poseOn').checked = S.settings.pose; $('rulesetSel').value = S.settings.ruleset; $('detSel').value = S.settings.detector || 'auto';

// ---------- timeline ----------
const fmtClock = () => GameClock.format(clock.remainingMs());
function timeline(text, kind = 'info') {
  const e = recorder.log(kind, { text, period: clock.period, gameClock: fmtClock() }, serverNowMs() / 1000);
  const el = document.createElement('div'); el.className = 'tl-item'; el.innerHTML = `<span>Q${e.period} ${e.gameClock}</span><div>${esc(text)}</div>`; $('timeline').prepend(el);
}

// ---------- signalling / match ----------
sig.on('welcome', m => {
  S.match = { matchId: m.matchId, hostToken: m.hostToken, code: m.code, joinKey: m.joinKey, name: m.name }; store.set('cs-host', { matchId: m.matchId, hostToken: m.hostToken });
  recorder.matchId = m.matchId; $('matchName').value = m.name; $('matchTag').textContent = 'MATCH ' + m.name.toUpperCase() + ' · ' + m.matchId;
  for (const c of m.cameras) { const cam = cm.ensure(c.cameraId, c.label, 'PHONE'); cm.setState(cam, c.online ? 'connecting' : 'offline'); }
  renderPairing(); timeline(`Referee station connected to match ${m.name}.`);
});
sig.on('code', m => { S.match.code = m.code; S.match.joinKey = m.joinKey; renderPairing(); timeline('New pairing code generated.'); });
sig.on('error', m => { if (m.code === 'bad-token') { store.set('cs-host', null); S.match = null; sig.ws.close(); } $('hostMessage').textContent = m.message || m.code; });
sig.on('camera-online', m => { cm.onCameraOnline(m); timeline(`${m.label} joined / reconnected.`); });
sig.on('camera-offline', m => { cm.onCameraOffline(m); timeline(`${cm.cams.get(m.cameraId)?.label || m.cameraId} lost connection — waiting for it to reconnect.`, 'warn'); });
sig.on('signal', m => cm.onSignal(m));
sig.on('open', () => $('sigStatus').textContent = 'connected'); sig.on('close', () => $('sigStatus').textContent = 'reconnecting…');

cm.on(onCameraEvent);
fetch('/api/ice').then(r => r.json()).then(ice => { cm.ice = ice.iceServers; }).catch(() => { });
fetch('/api/info').then(r => r.json()).then(i => { S.info = i; renderPairing(); }).catch(() => { });

function bases() {
  const out = []; if (S.info?.publicUrl) out.push(S.info.publicUrl.replace(/\/$/, ''));
  if (location.protocol === 'https:') out.push(location.origin);
  for (const ip of S.info?.lan || []) out.push(`https://${ip}:${S.info.httpsPort}`);
  if (!out.length) out.push(location.origin); return [...new Set(out)];
}
function renderPairing() {
  if (!S.match?.code) return; const sel = $('baseSel'), cur = sel.value; const B = bases();
  sel.innerHTML = B.map(b => `<option>${esc(b)}</option>`).join(''); if (B.includes(cur)) sel.value = cur;
  const url = `${sel.value}/camera.html?m=${S.match.matchId}&k=${S.match.joinKey}`;
  $('pairCode').textContent = S.match.code; $('pairUrl').textContent = url;
  $('qr').innerHTML = `<img alt="Pairing QR code" src="/api/qr?text=${encodeURIComponent(url)}">`;
  $('hostMessage').textContent = sel.value.startsWith('http:') ? 'Warning: phones need an https:// address for camera access.' : 'Ready. Each phone that scans this joins as a new camera.';
}
$('baseSel').onchange = renderPairing; $('rotateCode').onclick = () => sig.send({ type: 'rotate-code' });
$('newPair').onclick = () => $('pair-panel').scrollIntoView({ behavior: 'smooth' });
$('newMatch').onclick = () => { if (!confirm('Start a new match? Paired phones must pair again.')) return; store.set('cs-host', null); location.reload(); };

// ---------- cameras ----------
async function listLocal() { try { const d = await navigator.mediaDevices.enumerateDevices(); $('localCamSel').innerHTML = '<option value="">Default camera</option>' + d.filter(x => x.kind === 'videoinput').map((c, i) => `<option value="${c.deviceId}">${esc(c.label || 'Camera ' + (i + 1))}</option>`).join(''); } catch { } }
listLocal();
$('addLocal').onclick = async () => {
  try { if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Open the dashboard from https:// or http://localhost to use cameras.'); await cm.addLocal($('localCamSel').value); listLocal(); }
  catch (e) { timeline('Camera setup failed: ' + e.message, 'warn'); alert('Could not add camera: ' + e.message); }
};
function onCameraEvent(ev) {
  const c = ev.cam;
  if (ev.type === 'added') { makeCard(c); if (c.kind === 'LOCAL') timeline(`${c.label} added (this device).`); }
  if (ev.type === 'removed') { S.cards.get(c.id)?.el.remove(); S.cards.delete(c.id); S.pipelines.get(c.id)?.stop(); S.pipelines.delete(c.id); analyzer.removeCamera(c.id); timeline(`${c.label} removed.`); }
  if (ev.type === 'state') { updateCard(c); if (c.state === 'live') timeline(`${c.label} video live.`); }
  if (ev.type === 'motion') S.pipelines.get(c.id)?.health.noteDeviceMotion(performance.now() / 1000, ev.mag);
  if (ev.type === 'stats') { timestamper.setStats(c.id, c.stats); S.pipelines.get(c.id)?.health.noteNetwork(c.stats); }
  if (ev.type === 'ack' && !ev.ok) timeline(`${c.label}: "${ev.cmd}" not supported (${ev.error})`, 'warn');
  if (ev.type === 'caps') updateCard(c);
}
function makeCard(c) {
  $('emptyCard')?.remove();
  const el = document.createElement('div'); el.className = 'camera-card'; el.dataset.cam = c.id;
  el.innerHTML = `<div class="camera-head"><b class="cname"></b><span class="camera-state">—</span></div><div class="stage"></div><div class="issues"></div><div class="camera-foot"></div>
   <div class="controls"><button class="sm primary act-cal">Calibrate</button><button class="sm act-ana">Analysis on</button><button class="sm act-lines">Court lines</button>${c.kind === 'PHONE' ? '<button class="sm act-flip">Flip</button><button class="sm act-pause">Pause</button><button class="sm act-torch">Torch</button><button class="sm act-hd">720p/480p</button>' : ''}<button class="sm danger act-rm">Remove</button></div>`;
  const stage = el.querySelector('.stage'), overlay = document.createElement('canvas'); stage.append(c.video, overlay);
  $('cameraGrid').append(el);
  const card = { el, overlay, showLines: true, hd: true, torch: false }; S.cards.set(c.id, card);
  const calib = store.get(`cs-calib-${S.match?.matchId}-${c.id}`);
  const p = new CameraPipeline({ cam: c, analyzer, detector, timestamper, recorder, serverNow: serverNowMs, opts: { get fps() { return S.settings.fps; }, get pose() { return S.settings.pose; }, poseModel: '/models/pose_landmarker_lite.task', drawCourt } });
  S.pipelines.set(c.id, p);
  if (calib) { analyzer.setCalibration(c.id, calib); if (calib.refThumb) p.health.setReference(Float32Array.from(calib.refThumb), 96, 54); if (calib.fit) p.health.noteCourtFit(calib.fit, true); }
  el.querySelector('.act-cal').onclick = () => openCalibration(c.id);
  el.querySelector('.act-ana').onclick = e => { p.enabled = !p.enabled; analyzer.camera(c.id).enabled = p.enabled; e.target.textContent = p.enabled ? 'Analysis on' : 'Analysis off'; };
  el.querySelector('.act-lines').onclick = () => card.showLines = !card.showLines;
  el.querySelector('.act-rm').onclick = () => { if (confirm('Remove ' + c.label + '?')) { store.set(`cs-calib-${S.match?.matchId}-${c.id}`, null); cm.remove(c.id); } };
  el.querySelector('.act-flip')?.addEventListener('click', () => cm.command(c.id, { type: 'flip' }) || timeline('Camera control channel not open yet', 'warn'));
  el.querySelector('.act-pause')?.addEventListener('click', e => { c.paused = !c.paused; cm.command(c.id, { type: 'pause', paused: c.paused }); e.target.textContent = c.paused ? 'Resume' : 'Pause'; });
  el.querySelector('.act-torch')?.addEventListener('click', () => { card.torch = !card.torch; cm.command(c.id, { type: 'torch', on: card.torch }); });
  el.querySelector('.act-hd')?.addEventListener('click', () => { card.hd = !card.hd; cm.command(c.id, card.hd ? { type: 'quality', width: 1280, height: 720, fps: 30 } : { type: 'quality', width: 854, height: 480, fps: 30 }); });
  el.onclick = e => { if (e.target.tagName !== 'BUTTON') { document.querySelectorAll('.camera-card').forEach(x => x.classList.remove('selected')); el.classList.add('selected'); } };
  updateCard(c);
}
function updateCard(c) {
  const card = S.cards.get(c.id); if (!card) return;
  card.el.querySelector('.cname').textContent = c.label.toUpperCase();
  const st = card.el.querySelector('.camera-state'); st.textContent = c.kind + ' · ' + c.state.toUpperCase(); st.className = 'camera-state ' + (c.state === 'live' ? 'live' : c.state === 'reconnecting' ? 'warn' : c.state === 'offline' ? 'bad' : '');
  updateStats();
}
function updateStats() {
  const cams = [...(cm?.cams.values() || [])], live = cams.filter(c => c.state === 'live').length;
  $('camCount').textContent = `${live} live / ${cams.length}`; $('globalDot').classList.toggle('on', live > 0);
  $('globalState').textContent = live ? live + ' CAMERA' + (live === 1 ? '' : 'S') + ' LIVE' : 'NO CAMERAS CONNECTED';
  $('calCount').textContent = cams.filter(c => analyzer.camera(c.id).calib).length + ' / ' + cams.length;
}

// ---------- analysis tick ----------
const LATENCY = 0.18; // s: let frames from all cameras arrive before fusing (sync window)
setInterval(() => {
  if (!$('analysisOn').checked || !S.pipelines.size) return;
  const t = serverNowMs() / 1000 - LATENCY;
  let st; try { st = analyzer.tick(t); } catch (e) { console.error(e); return; }
  for (const a of st.actions) onAction(a);
  for (const al of st.alerts) addAlert(al);
  for (const i of st.info) timeline(`${i.player} is out of bounds (no ball).`);
  S.lastState = st;
}, 100);
setInterval(() => { clock.tick(); }, 50);
setInterval(() => cm?.pollStats(), 2000);

function teamName(team) { const side = score.sideOf(team); return side ? side.toUpperCase() : 'team ?'; }
function onAction(a) {
  if (a.type === 'shot') timeline(`Shot attempt by ${a.player} (${a.freeThrow ? 'free throw' : a.points + 'PT' + (a.pointsUncertain ? '?' : '')}) — ${a.reasons.join('; ')}`, 'action');
  if (a.type === 'shot_result') {
    timeline(`Shot ${a.shotId}: ${a.result.toUpperCase()} (evidence ${a.confidence.toFixed(2)}) — ${a.reasons.join('; ')}`, 'action');
    if (a.result !== 'missed') { score.autoEnabled = $('autoScore').checked; const r = score.handleShotResult(a); if (r.action === 'applied') { timeline(`+${a.points} ${teamName(a.team)} (automatic)`, 'score'); clock.onMadeBasket(); } if (r.action === 'pending') timeline(`Basket needs confirmation: ${r.reason}`, 'warn'); renderScore(); }
  }
  if (a.type === 'pass') timeline(`Pass ${a.from} → ${a.to}`, 'action');
  if (a.type === 'turnover') timeline(`Turnover: ${a.to} (${teamName(a.team)}) intercepted from ${a.from}`, 'action');
  if (a.type === 'rebound') timeline(`${a.offensive ? 'Offensive' : 'Defensive'} rebound: ${a.player}`, 'action');
}
clock.on(e => {
  if (e.type === 'period_end') timeline(`End of period ${e.period}.`, 'clock');
  if (e.type === 'clock_stop' && e.reason !== 'manual') timeline(`Clock stopped: ${e.reason}`, 'clock');
  if (e.type === 'shot_clock_reset' && e.reason !== 'manual' && e.reason !== 'reset') timeline(`Shot clock ${e.seconds}: ${e.reason}`, 'clock');
  if (e.type === 'shot_clock_expired') addAlert(makeAlert(ruleset, { type: 'shot_clock', label: 'Shot-clock violation', t: serverNowMs() / 1000, tStart: serverNowMs() / 1000 - 4, tEnd: serverNowMs() / 1000 + 1, players: [], team: analyzer.possession.team, confidence: 0.7, cams: [], reasons: ['Shot clock reached 0. Check whether the ball left the shooter\'s hand before expiry and touched the ring (FIBA Art. 29).'], forceReview: true }));
});

// ---------- alerts ----------
function addAlert(al) {
  al.gameClock = fmtClock(); al.period = clock.period;
  const a = alerts.add(al); if (a !== al) return; // merged into an existing alert
  timeline(`ALERT ${a.label} [${a.status === 'flagged' ? 'FLAGGED' : 'NEEDS HUMAN REVIEW'}] ${(a.players || []).join(', ')}`, 'alert');
  const wait = Math.max(0, (a.tEnd ?? a.t + 1) - serverNowMs() / 1000 + LATENCY) * 1000 + 400;
  setTimeout(() => { a.clip = recorder.captureClip(a.id, a.tStart ?? a.t - 3, a.tEnd ?? a.t + 1, null); if (S.selectedAlert === a.id) renderReview(); }, wait);
  renderAlerts();
}
function renderAlerts() {
  const list = alerts.alerts; $('alertCount').textContent = alerts.pending().length + ' pending';
  if (!list.length) return;
  $('alertList').innerHTML = list.map(a => `<div class="alert ${S.selectedAlert === a.id ? 'sel' : ''}" data-id="${a.id}"><span class="badge ${a.decision !== 'pending' ? a.decision : a.status}">${a.decision !== 'pending' ? a.decision.toUpperCase() : a.status === 'flagged' ? 'FLAGGED' : 'NEEDS HUMAN REVIEW'}</span><div><b>${esc(a.label)}</b><small>Q${a.period} ${a.gameClock} · ${esc((a.players || []).join(', ') || 'player unknown')} · ${esc((a.cams || []).join(', ') || 'cams n/a')}</small></div><span class="conf">${a.confidence.toFixed(2)}</span></div>`).join('');
  $('alertList').querySelectorAll('.alert').forEach(el => el.onclick = () => { S.selectedAlert = el.dataset.id; renderAlerts(); renderReview(); });
}
function renderReview() {
  const a = alerts.get(S.selectedAlert), R = $('review'); if (!a) { R.hidden = true; return; } R.hidden = false;
  const cams = Object.keys(a.clip?.frames || {});
  R.innerHTML = `<h3>${esc(a.label)} <span class="badge ${a.status}">${a.status === 'flagged' ? 'FLAGGED — CONFIRM?' : 'NEEDS HUMAN REVIEW'}</span></h3>
   <div class="meta"><span>Time</span><b>Q${a.period} ${a.gameClock} (match t=${a.t.toFixed(2)} s)</b><span>Player(s)</span><b>${esc((a.players || []).join(', ') || 'unknown')}${a.fouler ? ' · fouler ' + esc(a.fouler) : ''}</b><span>Team</span><b>${a.team === null || a.team === undefined ? 'unknown' : teamName(a.team)}</b><span>Evidence score</span><b>${a.confidence.toFixed(2)} <span class="muted small">(heuristic, uncalibrated)</span></b><span>Cameras</span><b>${esc((a.cams || []).join(', ') || '—')}</b><span>Decision</span><b>${a.decision}${a.note ? ' — ' + esc(a.note) : ''}</b></div>
   <ul>${(a.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
   ${cams.length ? `<div class="clip"><canvas id="clipCanvas" width="480" height="270"></canvas></div><div class="clip-bar"><select id="clipCam">${cams.map(c => `<option>${esc(c)}</option>`).join('')}</select><button class="sm" id="clipPlay">▶ Play</button><input type="range" id="clipPos" min="0" max="1000" value="0"><button class="sm" id="clipSave">Save WebM</button></div>` : `<p class="muted small">${a.clip ? 'No frames recorded for this period (analysis was off or no camera).' : 'Video evidence is being collected…'}</p>`}
   <div class="controls" style="padding:0"><button class="primary" id="decConfirm">Confirm</button><button class="danger" id="decReject">Reject</button><button class="secondary" id="decReview">Review later</button></div>`;
  $('decConfirm').onclick = () => decide(a, 'confirmed'); $('decReject').onclick = () => decide(a, 'rejected'); $('decReview').onclick = () => decide(a, 'review');
  if (cams.length) clipPlayer(a);
}
function decide(a, d) {
  const note = d === 'rejected' ? (prompt('Reason for rejecting (optional):') || '') : '';
  alerts.decide(a.id, d, note); timeline(`Referee ${d.toUpperCase()}: ${a.label} ${(a.players || []).join(', ')}${note ? ' — ' + note : ''}`, 'decision');
  if (d === 'confirmed' && $('autoClock').checked) clock.onConfirmedWhistle(`${a.label} confirmed`);
  renderAlerts(); renderReview(); saveLog();
}
function clipPlayer(a) {
  const cv = $('clipCanvas'), x = cv.getContext('2d'); let frames = [], idx = 0, playing = false, timer = null; const imgs = new Map();
  const show = async i => { const f = frames[i]; if (!f) return; let im = imgs.get(f); if (!im) { im = await createImageBitmap(f.payload); imgs.set(f, im); } cv.width = im.width; cv.height = im.height; x.drawImage(im, 0, 0); x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(0, 0, 190, 20); x.fillStyle = '#fff'; x.font = '12px system-ui'; x.fillText(`${(f.t - a.t >= 0 ? '+' : '') + (f.t - a.t).toFixed(2)} s from event`, 6, 14); if (Math.abs(f.t - a.t) < 0.1) { x.strokeStyle = '#ff7777'; x.lineWidth = 4; x.strokeRect(2, 2, cv.width - 4, cv.height - 4); } $('clipPos').value = frames.length > 1 ? Math.round(1000 * i / (frames.length - 1)) : 0; };
  const load = () => { frames = a.clip.frames[$('clipCam').value] || []; idx = Math.max(0, frames.findIndex(f => f.t >= a.t)); show(idx); };
  $('clipCam').onchange = load; load();
  $('clipPos').oninput = e => { idx = Math.round(e.target.value / 1000 * (frames.length - 1)); show(idx); };
  $('clipPlay').onclick = () => { playing = !playing; $('clipPlay').textContent = playing ? '❚❚ Pause' : '▶ Play'; clearTimeout(timer); const step = () => { if (!playing) return; idx = (idx + 1) % frames.length; show(idx); const dt = frames[(idx + 1) % frames.length].t - frames[idx].t; timer = setTimeout(step, Math.max(20, Math.min(400, dt * 1000))); }; step(); };
  $('clipSave').onclick = async () => {
    const stream = cv.captureStream(15), rec = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = []; rec.ondataavailable = e => chunks.push(e.data);
    rec.start(); for (let i = 0; i < frames.length; i++) { await show(i); await new Promise(r => setTimeout(r, Math.max(20, Math.min(400, ((frames[i + 1]?.t ?? frames[i].t + 0.1) - frames[i].t) * 1000)))); } rec.stop();
    await new Promise(r => rec.onstop = r); const blob = new Blob(chunks, { type: 'video/webm' }), name = `${a.id}-${a.type}-${$('clipCam').value}.webm`;
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click();
    if (S.match) fetch(`/api/matches/${S.match.matchId}/clips/${name}`, { method: 'POST', headers: { 'x-host-token': S.match.hostToken }, body: blob }).then(r => r.ok && timeline(`Evidence clip ${name} saved on server.`)).catch(() => { });
  };
}

// ---------- score ----------
function renderScore() {
  $('homeScore').textContent = String(score.score.home).padStart(2, '0'); $('awayScore').textContent = String(score.score.away).padStart(2, '0');
  $('pendingScores').innerHTML = score.pending.map(p => `<div class="pending-item"><b>Confirm basket?</b> ${esc(p.player || '')} · ${p.side ? p.side.toUpperCase() : 'team ?'} · ${p.points}PT${p.pointsUncertain ? '?' : ''}<br><span class="muted">${esc(p.pendingReasons.join('; '))}</span><div class="row">${[1, 2, 3].map(n => `<button class="sm" data-s="${p.shotId}" data-p="${n}" data-side="home">HOME +${n}</button>`).join('')}${[1, 2, 3].map(n => `<button class="sm" data-s="${p.shotId}" data-p="${n}" data-side="away">AWAY +${n}</button>`).join('')}<button class="sm danger" data-s="${p.shotId}" data-p="0">No basket</button></div></div>`).join('');
  $('pendingScores').querySelectorAll('button').forEach(b => b.onclick = () => { const e = score.resolvePending(b.dataset.s, { points: +b.dataset.p, side: b.dataset.side }); timeline(e ? `+${e.points} ${e.side.toUpperCase()} (confirmed by referee)` : 'Basket rejected by referee', 'score'); if (e) clock.onMadeBasket(); renderScore(); });
}
document.querySelectorAll('[data-team]').forEach(b => b.onclick = () => { const e = score.add(b.dataset.team, +b.dataset.points, { source: 'manual', t: serverNowMs() / 1000 }); if (e) timeline(`${e.side.toUpperCase()} ${e.points > 0 ? '+' : ''}${e.points} (manual)`, 'score'); renderScore(); });
$('undoScore').onclick = () => { const e = score.undo(); if (e) timeline(`Undo: ${e.side.toUpperCase()} ${e.points}`, 'score'); renderScore(); };
$('swapTeams').onclick = () => { S.teamSwap = !S.teamSwap; score.teamMap = S.teamSwap ? { 0: 'away', 1: 'home' } : { 0: 'home', 1: 'away' }; timeline('Team colour mapping swapped.'); };

// ---------- clock ----------
$('clockToggle').onclick = () => { clock.toggle(); timeline(clock.running ? 'Clock started.' : 'Clock paused.', 'clock'); };
$('resetShot').onclick = () => clock.resetShotClock(ruleset.timing.shotClock); $('shot14').onclick = () => clock.resetShotClock(ruleset.timing.shotClockOffensiveRebound);
$('nextPeriod').onclick = () => { clock.nextPeriod(); timeline(`Period ${clock.period} ready.`, 'clock'); };
$('resetClock').onclick = () => { if (!confirm('Reset clock and score for a new game?')) return; clock.resetGame(); score.reset(); renderScore(); timeline('Game reset.', 'clock'); };
$('autoClock').onchange = e => clock.autoManage = e.target.checked;
document.querySelectorAll('[data-call]').forEach(b => b.onclick = () => timeline('MANUAL FLAG: ' + b.dataset.call, 'manual'));
$('exportLog').onclick = () => { const blob = new Blob([JSON.stringify(logPayload(), null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `courtside-${S.match?.matchId || 'match'}.json`; a.click(); };
function logPayload() { return { match: S.match && { id: S.match.matchId, name: S.match.name }, ruleset: ruleset.id, score: score.toJSON(), clock: clock.snapshot(), events: recorder.events, alerts: alerts.alerts.map(({ clip, ...a }) => a) }; }
function saveLog() { if (S.match) fetch(`/api/matches/${S.match.matchId}/log`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-host-token': S.match.hostToken }, body: JSON.stringify(logPayload()) }).catch(() => { }); }
setInterval(saveLog, 15000);

// ---------- settings ----------
const saveSettings = () => store.set('cs-settings', S.settings);
$('fpsSel').onchange = e => { S.settings.fps = +e.target.value; saveSettings(); };
$('poseOn').onchange = e => { S.settings.pose = e.target.checked; saveSettings(); };
$('rulesetSel').onchange = e => { S.settings.ruleset = e.target.value; saveSettings(); if (confirm('Reload to apply the ' + e.target.value + ' ruleset?')) location.reload(); };
$('rulesStatus').textContent = ruleset.name;
$('detSel').onchange = e => { S.settings.detector = e.target.value; saveSettings(); location.reload(); };

// ---------- drawing ----------
function drawCourt(x, Hc2i, s) {
  x.strokeStyle = 'rgba(140,200,255,.6)'; x.lineWidth = 1.5;
  for (const m of model.markings(0.2)) { x.beginPath(); let pen = false; for (const p of m.pts) { if (hDepth(Hc2i, p) <= 0) { pen = false; continue; } const q = applyH(Hc2i, p); if (pen) x.lineTo(q[0] * s, q[1] * s); else x.moveTo(q[0] * s, q[1] * s); pen = true; } x.stroke(); }
}
function drawMap() {
  const cv = $('courtMap'), x = cv.getContext('2d'), W = cv.width, H = cv.height, sc = Math.min((W - 20) / model.d.length, (H - 20) / model.d.width);
  const P = ([cx, cy]) => [W / 2 + cx * sc, H / 2 + cy * sc];
  x.fillStyle = '#20302a'; x.fillRect(0, 0, W, H); x.fillStyle = '#5a4630'; const [a0, b0] = P([-model.hx, -model.hy]); x.fillRect(a0, b0, model.d.length * sc, model.d.width * sc);
  x.strokeStyle = '#e8efe9'; x.lineWidth = 1.2; for (const m of model.markings(0.2)) { x.beginPath(); m.pts.forEach((p, i) => { const q = P(p); i ? x.lineTo(...q) : x.moveTo(...q); }); x.stroke(); }
  for (const [id, c] of analyzer.cams) { const cmod = c.calib?.camModel; if (!cmod?.reliable) continue; const q = P(cmod.centre); x.fillStyle = '#8cc8ff'; x.fillRect(Math.max(2, Math.min(W - 8, q[0] - 3)), Math.max(2, Math.min(H - 8, q[1] - 3)), 6, 6); x.fillText(id, Math.max(2, Math.min(W - 40, q[0] + 5)), Math.max(10, Math.min(H - 2, q[1]))); }
  const st = S.lastState; if (!st) return;
  for (const p of st.players) {
    const q = P(p.pos), col = p.team === null ? '#9fb3ab' : (score.sideOf(p.team) === 'home' ? '#c7ff4a' : '#ff914d');
    x.fillStyle = col; x.beginPath(); x.arc(q[0], q[1], 6, 0, 7); x.fill();
    if (model.isOut(p.pos)) { x.strokeStyle = '#ff7777'; x.lineWidth = 2; x.beginPath(); x.arc(q[0], q[1], 9, 0, 7); x.stroke(); }
    if (st.poss.controller === p.id) { x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath(); x.arc(q[0], q[1], 11, 0, 7); x.stroke(); }
    x.fillStyle = '#fff'; x.font = 'bold 10px system-ui'; x.fillText(p.label || p.id, q[0] + 8, q[1] - 6);
  }
  if (st.ball.X) { const q = P(st.ball.X); x.fillStyle = '#ff914d'; x.beginPath(); x.arc(q[0], q[1], 4, 0, 7); x.fill(); x.fillStyle = '#ffd18c'; x.fillText(st.ball.X[2].toFixed(1) + ' m', q[0] + 6, q[1] + 4); }
}
function render() {
  for (const [id, p] of S.pipelines) {
    const card = S.cards.get(id); if (!card) continue; const ov = card.overlay, stage = ov.parentElement, r = stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (ov.width !== Math.round(r.width * dpr)) { ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr); }
    const x = ov.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, ov.width, ov.height);
    const sz = p.size(); if (!sz) continue; const s = Math.min(ov.width / sz.w, ov.height / sz.h); x.translate((ov.width - sz.w * s) / 2, (ov.height - sz.h * s) / 2);
    const calib = analyzer.camera(id).calib; if (card.showLines && calib) drawCourt(x, calib.Hc2i, s);
    p.drawOverlay(x, s, { showCourt: false });
  }
  $('clock').textContent = GameClock.format(clock.remainingMs()); $('shotClock').textContent = Math.ceil(clock.shotRemainingMs() / 1000);
  $('period').textContent = clock.period > ruleset.timing.periods ? 'OT' + (clock.period - ruleset.timing.periods) : 'Q' + clock.period; $('clockToggle').textContent = clock.running ? 'Pause' : 'Start';
  drawMap(); requestAnimationFrame(render);
}
requestAnimationFrame(render);
setInterval(() => {
  $('detStatus').textContent = detector.status; const p0 = [...S.pipelines.values()][0]; $('poseStatus').textContent = S.settings.pose ? (p0?.pose.status || '—') : 'off';
  const st = S.lastState; $('peopleCount').textContent = st ? st.players.length : '—';
  $('ballStatus').textContent = st ? (st.ball.X ? `3-D (${st.ball.X.map(v => v.toFixed(1)).join(', ')})` : Object.keys(st.ball.views).length ? 'seen in ' + Object.keys(st.ball.views).join(', ') : 'not visible') : '—';
  $('possState').textContent = st?.poss.controller ? `${st.poss.controller} (${teamName(st.poss.team)}) · ${st.poss.state}` : (st ? st.poss.state : '—');
  $('rateStatus').textContent = [...S.pipelines.values()].map(p => `${p.cam.id}: ${p.timings.total ? Math.round(p.timings.total) + ' ms' : '—'}`).join(' · ') + ` · fusion ${analyzer.analysisFps().toFixed(0)} Hz`;
  for (const [id, p] of S.pipelines) {
    const card = S.cards.get(id), c = cm.cams.get(id); if (!card || !c) continue; const h = p.healthReport, calib = analyzer.camera(id).calib;
    const iss = card.el.querySelector('.issues'); iss.textContent = h?.issues.map(i => i.msg).join(' · ') || ''; iss.className = 'issues ' + (h?.level === 'bad' ? 'bad' : '');
    card.el.querySelector('.camera-foot').innerHTML = `<span>Players: <b>${p.last ? p.last.out?.tracks.length ?? 0 : '—'}</b></span><span>Ball: <b>${p.last ? (analyzer.camera(id).ball.estimate()?.state || 'no') : '—'}</b></span><span>Calib: <b>${calib ? 'yes' + (calib.rims.length ? ' · rims ' + calib.rims.length : '') : 'NO'}</b></span><span>fps <b>${h ? h.fps.toFixed(0) : '—'}</b></span>${c.stats.rttMs !== undefined ? `<span>RTT <b>${Math.round(c.stats.rttMs)} ms</b></span><span>loss <b>${(c.stats.packetLossPct || 0).toFixed(1)}%</b></span>` : ''}${c.battery ? `<span>🔋 <b>${Math.round(c.battery.level * 100)}%</b></span>` : ''}${p.error ? `<span style="color:var(--red)">${esc(p.error)}</span>` : ''}`;
  }
  updateStats();
}, 500);
detector.load(S.settings.detector || 'auto').then(k => { if (k === 'COCO-SSD') analyzer.setTrackerOptions({ highThresh: 0.35, newTrackThresh: 0.4, lowThresh: 0.15 }); }).catch(() => { });
// periodic court-visibility check for calibrated cameras
setInterval(() => { for (const [id, p] of S.pipelines) { const c = analyzer.camera(id).calib; if (!c || !p.last) continue; const img = p.grab(); if (img) workerCall('fit', { img, H: c.Hc2i }).then(r => p.health.noteCourtFit(r.fraction)).catch(() => { }); } }, 20000);

// ---------- flash sync check ----------
$('flashSync').onclick = () => {
  const ps = [...S.pipelines.values()]; if (ps.length < 2) { $('syncInfo').textContent = 'Needs at least two cameras.'; return; }
  ps.forEach(p => p.lumSeries = []); $('syncInfo').textContent = 'Recording 6 s: flash a light (or switch the hall lights on) so ALL cameras see it…';
  setTimeout(() => {
    const times = {}; ps.forEach(p => { times[p.cam.id] = detectFlash(p.lumSeries); p.lumSeries = null; });
    const ref = ps.find(p => times[p.cam.id] !== null)?.cam.id, off = ref ? flashOffsets(times, ref) : null;
    if (!off || Object.keys(off).length < 2) { $('syncInfo').textContent = 'Flash not seen by enough cameras — try again.'; return; }
    for (const [cam, ms] of Object.entries(off)) timestamper.setCorrection(cam, (timestamper.correction.get(cam) || 0) + ms);
    $('syncInfo').textContent = 'Residual offsets corrected: ' + Object.entries(off).map(([c, v]) => `${c} ${v.toFixed(0)} ms`).join(', '); timeline('Camera sync check: ' + $('syncInfo').textContent);
  }, 6000);
};

// ---------- calibration ----------
const worker = new Worker('/js/app/calib-worker.js', { type: 'module' }); let wid = 0; const wp = new Map();
worker.onmessage = e => { const p = wp.get(e.data.id); wp.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); };
function workerCall(cmd, data) { return new Promise((res, rej) => { const id = ++wid; wp.set(id, { res, rej }); worker.postMessage({ id, cmd, court: ruleset.court, ...data }); }); }
const K = { cam: null, img: null, H: null, pts: {}, active: null, rimMode: null, rims: {}, support: null };
const KP = model.keypoints();
function openCalibration(camId) {
  const p = S.pipelines.get(camId), img = p?.grab(); if (!img) { alert('No video from this camera yet.'); return; }
  const prev = analyzer.camera(camId).calib;
  Object.assign(K, { cam: camId, img, H: prev?.Hc2i || null, pts: {}, active: Object.keys(KP)[0], rimMode: null, rims: Object.fromEntries((prev?.rims || []).filter(r => r.source === 'manual').map(r => [r.side, r])), support: null });
  $('calibTitle').textContent = 'Calibrate ' + (cm.cams.get(camId)?.label || camId); $('calibMsg').textContent = ''; $('calibModal').hidden = false; renderKp(); drawCalib();
}
function renderKp() { $('kpList').innerHTML = Object.keys(KP).map(k => `<div class="kp ${K.active === k ? 'active' : ''} ${K.pts[k] ? 'set' : ''}" data-k="${k}"><span>${k.replace(/_/g, ' ')}</span><b>${K.pts[k] ? '●' : '○'}</b></div>`).join(''); $('kpList').querySelectorAll('.kp').forEach(el => el.onclick = () => { K.active = el.dataset.k; K.rimMode = null; renderKp(); }); }
function drawCalib() {
  const cv = $('calibCanvas'), x = cv.getContext('2d'); cv.width = K.img.width; cv.height = K.img.height; x.putImageData(K.img, 0, 0);
  if (K.H) { x.save(); drawCourt(x, K.H, 1); x.restore(); x.strokeStyle = 'rgba(199,255,74,.9)'; }
  for (const [k, p] of Object.entries(K.pts)) { x.fillStyle = '#c7ff4a'; x.beginPath(); x.arc(p[0], p[1], 5, 0, 7); x.fill(); x.fillStyle = '#fff'; x.font = '12px system-ui'; x.fillText(k, p[0] + 7, p[1] - 7); }
  for (const r of Object.values(K.rims)) { x.strokeStyle = '#ff7777'; x.lineWidth = 2; x.beginPath(); x.ellipse(r.u, r.v, r.rx, r.ry, 0, 0, 7); x.stroke(); }
  const sp = K.support; $('calibInfo').innerHTML = sp ? Object.entries(sp).map(([g, v]) => `${g.replace('_', ' ')}: ${v.inView ? (v.detected ? '<b style="color:var(--lime)">detected</b>' : 'weak') + ` (${Math.round(v.fraction * 100)}% of ${v.visible} pts)` : 'not in view'}`).join('<br>') : (K.H ? 'Calibration loaded.' : 'Not calibrated.');
}
$('calibCanvas').onclick = e => {
  const cv = e.target, r = cv.getBoundingClientRect(), u = (e.clientX - r.left) * cv.width / r.width, v = (e.clientY - r.top) * cv.height / r.height;
  if (K.rimMode) { const side = K.rimMode.side; if (!K.rimMode.centre) { K.rimMode.centre = [u, v]; $('calibMsg').textContent = 'Now click the left or right edge of the rim.'; } else { const [cu, cvv] = K.rimMode.centre, rx = Math.max(3, Math.abs(u - cu)); K.rims[side] = { side, u: cu, v: cvv, rx, ry: Math.max(1.5, rx * 0.3), source: 'manual' }; K.rimMode = null; $('calibMsg').textContent = 'Rim marked.'; } drawCalib(); return; }
  K.pts[K.active] = [u, v]; const keys = Object.keys(KP), i = keys.indexOf(K.active); K.active = keys.find((k, j) => j > i && !K.pts[k]) || K.active; renderKp(); drawCalib();
};
$('calibAuto').onclick = async () => { $('calibMsg').textContent = 'Detecting court lines…'; try { const r = await workerCall('auto', { img: K.img }); if (!r.H) { $('calibMsg').textContent = 'Auto-detection failed: ' + r.reason + '. Use manual points.'; return; } K.H = r.H; K.support = r.support; $('calibMsg').textContent = `Court found (${Math.round(r.fraction * 100)}% of visible markings matched, ${r.elapsedMs} ms). The court is symmetric: use Flip ends / Flip sides so the overlay matches YOUR naming (same for every camera).`; drawCalib(); } catch (e) { $('calibMsg').textContent = e.message; } };
$('calibCompute').onclick = async () => { const clicked = Object.entries(K.pts).map(([k, p]) => ({ court: KP[k], img: p })); if (clicked.length < 4) { $('calibMsg').textContent = 'Click at least 4 named points.'; return; } $('calibMsg').textContent = 'Computing and refining against detected lines…'; try { const r = await workerCall('calibrate', { img: K.img, clicked }); K.H = r.H; K.support = r.support; $('calibMsg').textContent = `Method: ${r.method}. Fit ${Math.round((r.fit?.fraction || 0) * 100)}%.`; drawCalib(); } catch (e) { $('calibMsg').textContent = 'Failed: ' + e.message; } };
$('flipX').onclick = () => { if (K.H) { K.H = K.H.map(r => [-r[0], r[1], r[2]]); drawCalib(); } }; $('flipY').onclick = () => { if (K.H) { K.H = K.H.map(r => [r[0], -r[1], r[2]]); drawCalib(); } };
$('calibRefresh').onclick = () => { const img = S.pipelines.get(K.cam)?.grab(); if (img) { K.img = img; drawCalib(); } };
$('clearPts').onclick = () => { K.pts = {}; renderKp(); drawCalib(); };
$('rimL').onclick = () => { K.rimMode = { side: -1 }; $('calibMsg').textContent = 'Click the centre of the LEFT rim.'; }; $('rimR').onclick = () => { K.rimMode = { side: 1 }; $('calibMsg').textContent = 'Click the centre of the RIGHT rim.'; };
$('calibClose').onclick = () => $('calibModal').hidden = true;
$('calibSave').onclick = async () => {
  if (!K.H) { $('calibMsg').textContent = 'Nothing to save yet.'; return; }
  const rims = Object.values(K.rims), p = S.pipelines.get(K.cam);
  const calib = { Hc2i: K.H, width: K.img.width, height: K.img.height, rimsManual: rims.length ? rims : null };
  const c = analyzer.setCalibration(K.cam, calib);
  let fit = null; try { fit = (await workerCall('fit', { img: K.img, H: K.H })).fraction; } catch { }
  const t = p.lastThumb ? Array.from(p.lastThumb) : null; if (t) p.health.setReference(p.lastThumb, 96, 54); if (fit) p.health.noteCourtFit(fit, true);
  store.set(`cs-calib-${S.match?.matchId}-${K.cam}`, { ...calib, refThumb: t, fit });
  timeline(`${cm.cams.get(K.cam)?.label} calibrated (${c.camModel.reliable ? 'camera height ' + c.camModel.centre[2].toFixed(1) + ' m, ' : ''}${c.rims.length} rim(s)).`);
  $('calibModal').hidden = true; updateStats();
};
renderScore();
window.courtside = { analyzer, clock, score, alerts, recorder, sig, addAlert, get cm() { return cm; }, S, timestamper };
