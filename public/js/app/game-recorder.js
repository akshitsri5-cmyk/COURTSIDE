// Full-game recording of every camera angle with match metadata (name, date, start/end times, location).
// Chrome/Edge desktop: the referee picks a folder once and video is streamed straight to disk (safe for long
// games). Other browsers: video is kept in memory and downloaded when recording stops.
const safe = s => String(s || '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'match';
const stamp = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; };

export class GameRecorder {
  constructor() { this.active = false; this.segments = []; this.dir = null; this.mode = null; this.info = null; }
  /** cams: CameraManager camera objects ({id,label,stream}); meta: {matchId, matchName, location:{text,lat,lon,accuracy}} */
  async start(cams, meta) {
    if (this.active) return;
    this.dir = null; this.mode = 'memory';
    if (window.showDirectoryPicker) { try { this.dir = await window.showDirectoryPicker({ id: 'courtside-recordings', mode: 'readwrite' }); this.mode = 'disk'; } catch { /* cancelled: fall back to memory */ } }
    this.startedAt = new Date(); this.base = `COURTSIDE_${safe(meta.matchName)}_${stamp(this.startedAt)}`;
    this.info = { ...meta, startedAt: this.startedAt.toISOString(), startedLocal: this.startedAt.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    this.segments = []; this.active = true;
    for (const c of cams) await this.ensure(c);
  }
  /** Start (or restart after a reconnect) recording for one camera. */
  async ensure(cam) {
    if (!this.active || !cam.stream || !cam.stream.getVideoTracks().some(t => t.readyState === 'live')) return;
    const cur = this.segments.find(s => s.cam === cam.id && !s.endedAt);
    if (cur && cur.stream === cam.stream) return;
    if (cur) await this.close(cur);
    const n = this.segments.filter(s => s.cam === cam.id).length + 1;
    const file = `${this.base}_${safe(cam.label || cam.id)}${n > 1 ? '_part' + n : ''}.webm`;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(cam.stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    const seg = { cam: cam.id, label: cam.label, file, stream: cam.stream, rec, chunks: [], bytes: 0, startedAt: new Date().toISOString(), endedAt: null, queue: Promise.resolve() };
    if (this.dir) { const fh = await this.dir.getFileHandle(file, { create: true }); seg.writer = await fh.createWritable(); }
    rec.ondataavailable = e => { if (!e.data.size) return; seg.bytes += e.data.size; if (seg.writer) seg.queue = seg.queue.then(() => seg.writer.write(e.data)); else seg.chunks.push(e.data); };
    rec.start(5000); this.segments.push(seg);
  }
  async close(seg) {
    if (seg.endedAt) return; seg.endedAt = new Date().toISOString();
    if (seg.rec.state !== 'inactive') { const done = new Promise(r => seg.rec.addEventListener('stop', r, { once: true })); seg.rec.stop(); await done; }
    await seg.queue; if (seg.writer) await seg.writer.close();
  }
  /** Stop everything; summary = {score, clock, events, alerts, ruleset}. Returns the written/downloaded file names. */
  async stop(summary) {
    if (!this.active) return [];
    this.active = false; for (const s of this.segments) await this.close(s);
    const endedAt = new Date();
    const info = { ...this.info, endedAt: endedAt.toISOString(), endedLocal: endedAt.toString(), durationSec: Math.round((endedAt - this.startedAt) / 1000), storage: this.mode,
      cameras: this.segments.map(s => ({ camera: s.cam, label: s.label, file: s.file, startedAt: s.startedAt, endedAt: s.endedAt, bytes: s.bytes })), ...summary };
    const infoName = `${this.base}_match-info.json`, infoBlob = new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' });
    const files = [];
    if (this.dir) { const w = await (await this.dir.getFileHandle(infoName, { create: true })).createWritable(); await w.write(infoBlob); await w.close(); }
    else { for (const s of this.segments) if (s.chunks.length) download(new Blob(s.chunks, { type: 'video/webm' }), s.file); download(infoBlob, infoName); }
    files.push(...this.segments.map(s => s.file), infoName); this.lastInfo = info; this.segments = [];
    return files;
  }
  elapsedSec() { return this.active ? Math.round((Date.now() - this.startedAt) / 1000) : 0; }
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
