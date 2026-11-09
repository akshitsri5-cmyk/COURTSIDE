// Cross-camera identity by APPEARANCE (clothing colour), for when the cameras are not calibrated to a court.
// Built for 1v1: at most `maxIds` identities (A, B). Each camera's tracks are matched one-to-one to identities
// with the Hungarian algorithm on clothing-histogram distance; sticky per track so labels don't flicker.
// Limitation (by design, stated in the UI/README): two players in near-identical clothing cannot be told apart.
import { hungarian } from './hungarian.js';
import { appearanceDistance, blendEmbedding } from './appearance.js';

export class AppearanceLinker {
  constructor({ maxIds = 2, maxDist = 0.45, names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] } = {}) { this.o = { maxIds, maxDist, names }; this.ids = []; this.bind = new Map(); }
  /** cam: camera id; tracks: [{id, emb, hits}] (confirmed tracks of that camera). */
  update(cam, tracks) {
    const o = this.o, usable = tracks.filter(t => t.emb);
    // keep existing bindings if still similar enough; one identity per camera
    const used = new Set(), free = [];
    for (const t of usable) {
      const id = this.bind.get(cam + ':' + t.id), I = id && this.ids.find(x => x.name === id);
      if (I && !used.has(I.name) && appearanceDistance(I.emb, t.emb) < o.maxDist * 1.3) { used.add(I.name); I.emb = blendEmbedding(I.emb, t.emb, 0.05); }
      else { this.bind.delete(cam + ':' + t.id); free.push(t); }
    }
    const cand = this.ids.filter(I => !used.has(I.name));
    const a = hungarian(free.map(t => cand.map(I => appearanceDistance(I.emb, t.emb))), o.maxDist);
    free.forEach((t, i) => {
      if (a[i] >= 0) { const I = cand[a[i]]; this.bind.set(cam + ':' + t.id, I.name); used.add(I.name); }
      else if (this.ids.length < o.maxIds && (t.hits ?? 3) >= 3) { // a new, clearly different person
        const I = { name: o.names[this.ids.length], emb: t.emb }; this.ids.push(I); this.bind.set(cam + ':' + t.id, I.name); used.add(I.name);
      }
    });
  }
  label(cam, trackId) { return this.bind.get(cam + ':' + trackId) || null; }
  reset() { this.ids = []; this.bind.clear(); }
}
