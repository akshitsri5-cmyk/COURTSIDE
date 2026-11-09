// Game history + recordings stored IN THE APP (browser IndexedDB on the referee laptop). Recordings are written
// chunk by chunk while the game runs (safe for long games, no RAM build-up), so they survive a page reload.
const DB = 'courtside', VER = 1;
let dbp = null;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('games', { keyPath: 'id' }); const c = d.createObjectStore('chunks', { keyPath: ['seg', 'seq'] }); c.createIndex('seg', 'seg'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = async (store, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };

export const GameStore = {
  saveGame: g => tx('games', 'readwrite', s => s.put(g)),
  getGame: id => tx('games', 'readonly', s => s.get(id)),
  async listGames() { const all = await tx('games', 'readonly', s => s.getAll()); return (all || []).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')); },
  putChunk: (seg, seq, blob) => tx('chunks', 'readwrite', s => s.put({ seg, seq, blob })),
  async segmentBlob(seg, type = 'video/webm') { const rows = await tx('chunks', 'readonly', s => s.index('seg').getAll(seg)); return new Blob((rows || []).sort((a, b) => a.seq - b.seq).map(r => r.blob), { type }); },
  async deleteGame(id) {
    const g = await this.getGame(id); if (!g) return;
    for (const sgm of g.segments || []) { const rows = await tx('chunks', 'readonly', s => s.index('seg').getAllKeys(sgm.id)); await tx('chunks', 'readwrite', s => { for (const k of rows || []) s.delete(k); }); }
    await tx('games', 'readwrite', s => s.delete(id));
  },
  async usage() { try { const e = await navigator.storage.estimate(); return { usedMB: Math.round((e.usage || 0) / 1e6), quotaMB: Math.round((e.quota || 0) / 1e6) }; } catch { return null; } },
  async persist() { try { return await navigator.storage.persist(); } catch { return false; } },
};
