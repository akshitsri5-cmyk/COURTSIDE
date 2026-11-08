// Court calibration worker (keeps the UI responsive during line detection, ~1–4 s).
import { autoDetectCourt, calibrate, prepare, markingSupport, scoreHomography } from '../core/court-detection.js';
import { CourtModel } from '../core/court-model.js';
import { estimateHomography } from '../core/homography.js';
self.onmessage = e => {
  const { id, cmd, img, H, clicked, court } = e.data, model = new CourtModel(court);
  try {
    let r;
    if (cmd === 'auto') r = autoDetectCourt(img, { model });
    else if (cmd === 'calibrate') { const Hm = estimateHomography(clicked.map(c => c.court), clicked.map(c => c.img)); r = calibrate(img, Hm, { model, clicked }); }
    else if (cmd === 'fit') { const P = prepare(img); r = { H, support: markingSupport(H, P, model) }; const tot = Object.values(r.support).reduce((a, g) => [a[0] + g.matched, a[1] + g.visible], [0, 0]); r.fraction = tot[1] ? tot[0] / tot[1] : 0; }
    const { prep, lines, best, ...out } = r || {};
    self.postMessage({ id, ok: true, result: { ...out, fit: out.fit ? { fraction: out.fit.fraction } : undefined } });
  } catch (err) { self.postMessage({ id, ok: false, error: err.message }); }
};
