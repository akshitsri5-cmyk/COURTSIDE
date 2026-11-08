// Minimal synchronous event bus used to decouple modules (works in browser and Node).
export class EventBus {
  constructor() { this.h = new Map(); }
  on(type, fn) { (this.h.get(type) || this.h.set(type, new Set()).get(type)).add(fn); return () => this.h.get(type)?.delete(fn); }
  emit(type, payload) { for (const fn of this.h.get(type) || []) { try { fn(payload); } catch (e) { console.error('[bus]', type, e); } } for (const fn of this.h.get('*') || []) { try { fn({ type, payload }); } catch (e) { console.error(e); } } }
}
