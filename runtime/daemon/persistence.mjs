import { atomicJSON, readPrivateJSON, MAX_STATE_BYTES } from './paths.mjs';
import { rm } from 'node:fs/promises';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createPersistence(filename, { maxBytes = MAX_STATE_BYTES, now = Date.now } = {}) {
  let pending = null, timer = null, running = null, closed = false, failures = 0;
  function envelope(snapshot) {
    // The caller MUST pass pipeline.getState({ persistent: true }). This module
    // never receives raw host input, candidate content, or an API key.
    const bounded = structuredClone(snapshot);
    const recent = item => Number.isFinite(Date.parse(item?.at)) && Date.parse(item.at) >= now() - RETENTION_MS;
    bounded.history = Array.isArray(bounded.history) ? bounded.history.filter(recent).slice(-64) : [];
    bounded.activity = Array.isArray(bounded.activity) ? bounded.activity.filter(recent).slice(-256) : [];
    if (Array.isArray(bounded.sessionStates)) {
      bounded.sessionStates = bounded.sessionStates.slice(-16).map(session => ({
        ...session, history: Array.isArray(session.history) ? session.history.filter(recent).slice(-64) : [],
        activity: Array.isArray(session.activity) ? session.activity.filter(recent).slice(-256) : [],
      }));
    }
    const result = { schemaVersion: 1, savedAt: now(), snapshot: bounded };
    const histories = [bounded, ...(bounded.sessionStates ?? [])];
    while (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
      const oldest = histories.filter(session => session.history?.length)
        .sort((a, b) => Date.parse(a.history[0].at) - Date.parse(b.history[0].at))[0];
      if (!oldest) break;
      oldest.history.shift();
    }
    return result;
  }
  async function drain() {
    if (running) return running;
    running = (async () => {
      while (pending) {
        const value = pending; pending = null;
        try { await atomicJSON(filename, value, maxBytes); } catch { failures++; }
      }
    })();
    try { await running; } finally { running = null; }
  }
  return {
    async load() {
      try {
        const value = await readPrivateJSON(filename, maxBytes);
        if (Number.isFinite(value.savedAt) && now() - value.savedAt > RETENTION_MS) {
          await rm(filename, { force: true });
          return undefined;
        }
        if (value.schemaVersion !== 1 || !Number.isFinite(value.savedAt) ||
            value.savedAt > now() + 60_000 || now() - value.savedAt > RETENTION_MS ||
            value.snapshot?.schemaVersion !== 1) return undefined;
        return value.snapshot;
      } catch { return undefined; }
    },
    schedule(snapshot) {
      if (closed) return;
      try { pending = envelope(snapshot); } catch { failures++; return; }
      if (!timer) timer = setTimeout(() => { timer = null; void drain(); }, 100);
    },
    async flush() { clearTimeout(timer); timer = null; await drain(); },
    async close() { closed = true; clearTimeout(timer); timer = null; await drain(); },
    stats: () => ({ persistenceFailures: failures }),
  };
}
