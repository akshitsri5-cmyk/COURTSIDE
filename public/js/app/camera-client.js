// Phone camera client: captures video, connects to the referee dashboard over WebRTC (this side offers),
// reconnects automatically, streams telemetry (motion/battery/clock) and obeys camera controls.
import { SignalClient } from './signal-client.js';
const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let sig = null, pc = null, dc = null, stream = null, facing = 'environment', creds = null, ice = null, restartTimer = null, pendingIce = [], wakeLock = null, hostOnline = false, peerStartedAt = 0, offerNumber = 0, activeOffer = null;
if (qs.get('code')) $('code').value = qs.get('code');
const msg = (t, err) => { $('msg').textContent = t; $('msg').style.color = err ? '#ff9292' : ''; };
const setState = (t, ok) => { $('state').textContent = t; $('state').className = 'pill ' + (ok ? 'ok' : 'warn'); };

async function listCams() { try { const d = await navigator.mediaDevices.enumerateDevices(); $('camSel').innerHTML = '<option value="">Rear camera (default)</option>' + d.filter(x => x.kind === 'videoinput').map((c, i) => `<option value="${c.deviceId}">${c.label || 'Camera ' + (i + 1)}</option>`).join(''); } catch { } }
listCams();

async function getStream(deviceId) {
  const v = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } };
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...v, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
}

$('join').onclick = async () => {
  try {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera needs HTTPS. Open the https:// address shown by the server.');
    const code = $('code').value.trim(), matchId = qs.get('m'), joinKey = qs.get('k');
    if (!matchId && !/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from the referee dashboard.');
    msg('Starting camera…'); stream = await getStream($('camSel').value);
    stream.getVideoTracks()[0].contentHint = 'motion';
    $('preview').srcObject = stream; $('joinPanel').hidden = true; $('livePanel').hidden = false;
    ice = await fetch('/api/ice').then(r => r.json()).catch(() => ({ iceServers: [] }));
    // per-tab credentials survive reloads; the device-wide copy is only used to resume a camera that is OFFLINE
    const ss = matchId && JSON.parse(sessionStorage.getItem('cs-cam-' + matchId) || 'null'), ls = matchId && JSON.parse(localStorage.getItem('cs-cam-' + matchId) || 'null');
    creds = ss || (ls ? { ...ls, resume: true } : null);
    sig = new SignalClient(() => creds ? { type: 'hello', role: 'camera', matchId: creds.matchId, cameraId: creds.cameraId, cameraToken: creds.cameraToken, resume: !!creds.resume, joinKey, code: code || undefined, label: $('label').value }
      : { type: 'hello', role: 'camera', matchId: matchId || undefined, joinKey: joinKey || undefined, code: code || undefined, label: $('label').value });
    sig.on('welcome', m => { creds = { matchId: m.matchId, cameraId: m.cameraId, cameraToken: m.cameraToken }; localStorage.setItem('cs-cam-' + m.matchId, JSON.stringify(creds)); sessionStorage.setItem('cs-cam-' + m.matchId, JSON.stringify(creds)); $('camName').textContent = m.label + ' · ' + m.name; hostOnline = m.hostOnline; $('hostState').textContent = m.hostOnline ? 'online' : 'offline'; if (m.hostOnline) startPeer(); else setState('WAITING FOR DASHBOARD'); });
    sig.on('host-online', () => { hostOnline = true; $('hostState').textContent = 'online'; startPeer(); });
    sig.on('host-offline', () => { hostOnline = false; $('hostState').textContent = 'offline'; clearTimeout(restartTimer); try { pc?.close(); } catch { } pc = null; activeOffer = null; pendingIce = []; setState('DASHBOARD OFFLINE'); });
    sig.on('signal', async m => { const d = m.data, current = pc; try {
      if (d.offerId && d.offerId !== activeOffer) return; // answer/candidate for a closed peer
      if (d.sdp && current) { await current.setRemoteDescription(d.sdp); if (current === pc) await flushIce(current); }
      else if (d.candidate && current) { if (current.remoteDescription) await current.addIceCandidate(d.candidate); else pendingIce.push(d.candidate); }
    } catch (e) { if (current === pc) console.warn(e); } });
    sig.on('error', m => { if (m.code === 'bad-key' || m.code === 'no-match') { if (creds) { creds = null; localStorage.removeItem('cs-cam-' + matchId); } msg(m.message, true); setState('ERROR'); } });
    sig.on('kicked', () => { setState('REMOVED BY REFEREE'); leave(); });
    sig.on('close', () => setState('RECONNECTING…'));
    // Recover when an offer/answer or host reload notification was lost. The same camera ID is retained.
    setInterval(() => { if (hostOnline && sig.connected && stream && (!pc || (pc.connectionState !== 'connected' && Date.now() - peerStartedAt > 9000))) startPeer(); }, 3000);
    requestWake(); setInterval(() => { $('sync').textContent = sig.clock.ready ? '±' + Math.round(sig.clock.uncertainty) + ' ms' : '…'; }, 1000);
  } catch (e) { msg('Could not start: ' + e.message, true); }
};

async function flushIce(peer) {
  while (peer === pc && peer.remoteDescription && pendingIce.length) {
    const candidate = pendingIce.shift();
    try { await peer.addIceCandidate(candidate); } catch (e) { if (peer === pc) console.warn('ICE candidate', e); }
  }
}
function startPeer() {
  if (!hostOnline || !sig?.connected || !stream) return;
  peerStartedAt = Date.now();
  clearTimeout(restartTimer); try { pc?.close(); } catch { }
  pendingIce = [];
  const peer = pc = new RTCPeerConnection({ iceServers: ice?.iceServers || [] });
  const offerId = activeOffer = `${Date.now()}-${++offerNumber}`;
  const track = stream.getVideoTracks()[0], sender = pc.addTrack(track, stream);
  try { const p = sender.getParameters(); p.encodings = [{ maxBitrate: 2500000, maxFramerate: 30 }]; p.degradationPreference = 'maintain-framerate'; sender.setParameters(p).catch(() => { }); } catch { }
  dc = pc.createDataChannel('ctl'); dc.onopen = () => sendCaps(); dc.onmessage = e => command(JSON.parse(e.data));
  peer.onicecandidate = e => e.candidate && peer === pc && sig.send({ type: 'signal', data: { candidate: e.candidate, offerId } });
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return;
    const s = peer.connectionState; setState(s === 'connected' ? 'LIVE' : s.toUpperCase(), s === 'connected');
    if (s === 'failed') scheduleRestart(500); if (s === 'disconnected') scheduleRestart(4000);
    if (s === 'connected') clearTimeout(restartTimer);
  };
  (async () => { try { const o = await peer.createOffer(); if (peer !== pc) return; await peer.setLocalDescription(o); if (peer === pc) sig.send({ type: 'signal', data: { sdp: peer.localDescription, offerId } }); } catch (e) { if (peer === pc) { console.warn('offer', e); scheduleRestart(500); } } })();
  setState('CONNECTING');
}
function scheduleRestart(ms) { clearTimeout(restartTimer); restartTimer = setTimeout(() => { if (hostOnline && sig.connected && stream && pc?.connectionState !== 'connected') startPeer(); }, ms); }

function sendCaps() { const t = stream.getVideoTracks()[0]; const caps = t.getCapabilities?.() || {}, st = t.getSettings(); send({ type: 'caps', torch: !!caps.torch, zoom: caps.zoom || null, settings: { width: st.width, height: st.height, frameRate: st.frameRate, facingMode: st.facingMode }, clockOffset: sig.clock.offset }); $('vstat').textContent = `${st.width}×${st.height}@${Math.round(st.frameRate || 0)}`; }
function send(o) { if (dc?.readyState === 'open') dc.send(JSON.stringify(o)); }
async function command(c) {
  const t = stream.getVideoTracks()[0];
  try {
    if (c.type === 'flip') await flip();
    else if (c.type === 'pause') { t.enabled = !c.paused; $('pause').textContent = c.paused ? 'Resume video' : 'Pause video'; }
    else if (c.type === 'torch') await t.applyConstraints({ advanced: [{ torch: !!c.on }] });
    else if (c.type === 'zoom') await t.applyConstraints({ advanced: [{ zoom: c.value }] });
    else if (c.type === 'quality') await t.applyConstraints({ width: { ideal: c.width }, height: { ideal: c.height }, frameRate: { ideal: c.fps } });
    send({ type: 'ack', cmd: c.type, ok: true }); sendCaps();
  } catch (e) { send({ type: 'ack', cmd: c.type, ok: false, error: e.message }); }
}
async function flip() {
  facing = facing === 'environment' ? 'user' : 'environment';
  const ns = await getStream(); const nt = ns.getVideoTracks()[0]; nt.contentHint = 'motion';
  const sender = pc?.getSenders().find(s => s.track?.kind === 'video'); await sender?.replaceTrack(nt);
  stream.getTracks().forEach(t => t.stop()); stream = ns; $('preview').srcObject = ns;
}
$('flip').onclick = () => flip().catch(e => msg(e.message, true));
$('pause').onclick = () => { const t = stream.getVideoTracks()[0]; command({ type: 'pause', paused: t.enabled }); };
$('motionBtn').onclick = async () => {
  try { if (window.DeviceMotionEvent?.requestPermission) await DeviceMotionEvent.requestPermission(); } catch { }
  let last = 0; window.addEventListener('devicemotion', e => { const a = e.acceleration || {}; const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0); const now = performance.now(); if (mag > 1.5 && now - last > 300) { last = now; send({ type: 'motion', mag, t: sig.serverTime() }); } });
  $('motionBtn').disabled = true; $('motionBtn').textContent = 'Bump detection on';
};
$('leave').onclick = () => { if (creds) { localStorage.removeItem('cs-cam-' + creds.matchId); sessionStorage.removeItem('cs-cam-' + creds.matchId); } leave(); };
function leave() { hostOnline = false; clearTimeout(restartTimer); try { pc?.close(); } catch { } sig?.close(); stream?.getTracks().forEach(t => t.stop()); wakeLock?.release?.(); $('livePanel').hidden = true; $('joinPanel').hidden = false; msg('Disconnected.'); }
async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { } document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').then(w => wakeLock = w).catch(() => { }); }); }
setInterval(async () => { if (!navigator.getBattery || dc?.readyState !== 'open') return; const b = await navigator.getBattery(); send({ type: 'battery', level: b.level, charging: b.charging }); }, 30000);
