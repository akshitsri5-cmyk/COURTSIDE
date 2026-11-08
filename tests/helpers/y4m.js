// Write RGBA frames as a Y4M (YUV 4:2:0) file for Chromium's --use-file-for-fake-video-capture.
import fs from 'node:fs';
export function writeY4M(file, frames, w, h, fps = 30) {
  const fd = fs.openSync(file, 'w'); fs.writeSync(fd, `YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`);
  for (const rgba of frames) {
    const Y = Buffer.alloc(w * h), U = Buffer.alloc((w / 2) * (h / 2)), V = Buffer.alloc((w / 2) * (h / 2));
    for (let i = 0; i < w * h; i++) { const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2]; Y[i] = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b)); }
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) { const i = 4 * ((2 * y) * w + 2 * x), r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]; U[y * w / 2 + x] = Math.max(0, Math.min(255, 128 - 0.1687 * r - 0.3313 * g + 0.5 * b)); V[y * w / 2 + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.4187 * g - 0.0813 * b)); }
    fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, Y); fs.writeSync(fd, U); fs.writeSync(fd, V);
  }
  fs.closeSync(fd);
}
