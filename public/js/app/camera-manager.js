// Referee-dashboard side of the camera system: one RTCPeerConnection per paired phone (the phone offers),
// local cameras on this device, live stats (RTT, packet loss, fps), remote camera controls via data channel.
export class CameraManager {
  constructor(sig, iceServers) { this.sig = sig; this.ice = iceServers; this.cams = new Map(); this.listeners = []; this.localN = 0; this.pendingIce = new Map(); }
  on(f) { this.listeners.push(f); } emit(type, cam, extra = {}) { for (const f of this.listeners) f({ type, cam, ...extra }); }
  ensure(id, label, kind) {
    let c = this.cams.get(id);
    if (!c) { c = { id, label, kind, state: 'offline', video: document.createElement('video'), stream: null, pc: null, dc: null, caps: null, stats: {}, paused: false }; c.video.muted = true; c.video.playsInline = true; c.video.autoplay = true; this.cams.set(id, c); this.emit('added', c); }
    if (label) c.label = label; return c;
  }
  setState(c, s) { if (c.state !== s) { c.state = s; this.emit('state', c); } }
  async addLocal(deviceId) {
    const v = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...v, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    const c = this.ensure('local' + (++this.localN), 'This device ' + this.localN, 'LOCAL');
    c.stream = stream; c.video.srcObject = stream; c.video.play().catch(() => { }); this.setState(c, 'live');
    stream.getVideoTracks()[0].onended = () => this.setState(c, 'offline'); return c;
  }
  // ---- remote phones ----
  onCameraOnline(m) { const c = this.ensure(m.cameraId, m.label, 'PHONE'); this.setState(c, 'connecting'); }
  onCameraOffline(m) { const c = this.cams.get(m.cameraId); if (c) { c.pc?.close(); c.pc = null; c.offerId = null; c.pendingIce = []; this.pendingIce.delete(c.id); this.setState(c, 'reconnecting'); } }
  async onSignal(m) {
    const c = this.ensure(m.from, null, 'PHONE'), d = m.data;
    let processingPeer = null;
    try {
      if (d.sdp && d.sdp.type === 'offer') {
        try { c.pc?.close(); } catch { }
        const offerId = d.offerId || null;
        const pc = processingPeer = c.pc = new RTCPeerConnection({ iceServers: this.ice });
        c.offerId = offerId;
        // ICE may have arrived before the offer, or before the camera card existed.
        const early = this.pendingIce.get(c.id) || [];
        c.pendingIce = early.filter(x => !x.offerId || x.offerId === offerId).map(x => x.candidate);
        this.pendingIce.delete(c.id);
        pc.onicecandidate = e => e.candidate && pc === c.pc && this.sig.send({ type: 'signal', to: c.id, data: { candidate: e.candidate, offerId } });
        pc.ontrack = e => { if (pc !== c.pc) return; c.stream = e.streams[0] || new MediaStream([e.track]); c.video.srcObject = c.stream; c.video.play().catch(() => { }); c.receiver = e.receiver; try { e.receiver.jitterBufferTarget = 0; } catch { } };
        pc.ondatachannel = e => { if (pc !== c.pc) return; c.dc = e.channel; c.dc.onmessage = ev => this.onTelemetry(c, JSON.parse(ev.data)); };
        pc.onconnectionstatechange = () => { const s = pc.connectionState; if (pc !== c.pc) return; this.setState(c, s === 'connected' ? 'live' : s === 'failed' || s === 'disconnected' ? 'reconnecting' : s === 'closed' ? 'offline' : 'connecting'); };
        await pc.setRemoteDescription(d.sdp);
        if (pc !== c.pc) return;
        await this.flushIce(c, pc);
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        if (pc === c.pc) { this.sig.send({ type: 'signal', to: c.id, data: { sdp: pc.localDescription, offerId } }); await this.flushIce(c, pc); }
      } else if (d.candidate) {
        if (c.pc && (!d.offerId || d.offerId === c.offerId)) {
          (c.pendingIce ||= []).push(d.candidate);
          await this.flushIce(c, c.pc);
        } else if (!c.pc) {
          const q = this.pendingIce.get(c.id) || [];
          q.push({ candidate: d.candidate, offerId: d.offerId || null });
          this.pendingIce.set(c.id, q.slice(-64));
        } // Stale candidates for an earlier offer are intentionally ignored.
      }
    } catch (e) {
      // A superseded offer can fail while its RTCPeerConnection is being closed.
      if (processingPeer && processingPeer !== c.pc) return;
      console.warn('signal', e); this.emit('error', c, { error: e.message });
    }
  }
  async flushIce(c, pc) {
    if (c.flushingPeer === pc) return;
    c.flushingPeer = pc;
    try {
      while (pc === c.pc && pc.remoteDescription && c.pendingIce?.length) {
        const candidate = c.pendingIce.shift();
        try { await pc.addIceCandidate(candidate); } catch (e) { if (pc === c.pc) console.warn('ICE candidate', e); }
      }
    } finally { if (c.flushingPeer === pc) c.flushingPeer = null; }
  }
  onTelemetry(c, t) {
    if (t.type === 'caps') { c.caps = t; this.emit('caps', c); }
    else if (t.type === 'motion') this.emit('motion', c, { mag: t.mag, t: t.t });
    else if (t.type === 'battery') { c.battery = t; this.emit('battery', c); }
    else if (t.type === 'ack') this.emit('ack', c, t);
  }
  command(id, cmd) { const c = this.cams.get(id); if (c?.dc?.readyState === 'open') { c.dc.send(JSON.stringify(cmd)); return true; } return false; }
  remove(id) {
    const c = this.cams.get(id); if (!c) return;
    if (c.kind === 'PHONE') this.sig.send({ type: 'kick', cameraId: id }); else c.stream?.getTracks().forEach(t => t.stop());
    try { c.pc?.close(); } catch { } this.pendingIce.delete(id); this.cams.delete(id); this.emit('removed', c);
  }
  /** Network stats for remote cameras: RTT, jitter buffer delay, packet loss, decoded fps, bitrate. */
  async pollStats() {
    for (const c of this.cams.values()) {
      if (!c.pc || c.state !== 'live') continue;
      try {
        const r = await c.pc.getStats(); let rtt, inb;
        r.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime !== undefined) rtt = s.currentRoundTripTime * 1000; if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s; });
        const prev = c.stats._inb; const st = { rttMs: rtt };
        if (inb) {
          st.fps = inb.framesPerSecond; st.jitterBufferMs = inb.jitterBufferEmittedCount ? 1000 * inb.jitterBufferDelay / inb.jitterBufferEmittedCount : undefined;
          if (prev) { const dl = inb.packetsLost - prev.packetsLost, dr = inb.packetsReceived - prev.packetsReceived; st.packetLossPct = dl + dr > 0 ? 100 * dl / (dl + dr) : 0; st.kbps = 8 * (inb.bytesReceived - prev.bytesReceived) / Math.max(1, inb.timestamp - prev.timestamp); }
          st._inb = { packetsLost: inb.packetsLost, packetsReceived: inb.packetsReceived, bytesReceived: inb.bytesReceived, timestamp: inb.timestamp };
        }
        c.stats = st; this.emit('stats', c);
      } catch { }
    }
  }
}
