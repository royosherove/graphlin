import { id, integer, jsonBytes } from '../extensions/contracts.mjs';

const COLLECTIONS = ['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints'];
export const VIEW_MODEL_LIMITS = Object.freeze({
  entities: 2048, relations: 4096, interpretations: 512, activity: 2048, sessions: 100, checkpoints: 100,
});
const stalePage = () => Object.assign(new Error('inconsistent_model_page'), { status: 409 });

export function readModel(value) {
  if (value?.schemaVersion !== 2 || !id(value.projectId) ||
    !integer(value.revision) || !integer(value.sequence)) throw new Error('invalid_model');
  for (const [key, max] of Object.entries({
    entities: 20000, relations: 40000, interpretations: 512, activity: 2048, sessions: 100, checkpoints: 100,
  })) if (!Array.isArray(value[key]) || value[key].length > max) throw new Error('invalid_model');
  jsonBytes(value, 8 * 1024 * 1024);
  for (const entity of value.entities) if (!id(entity.id) || typeof entity.label !== 'string' ||
    !Array.isArray(entity.sourceRefs)) throw new Error('invalid_model_entity');
  if (new Set(value.entities.map(entity => entity.id)).size !== value.entities.length) throw new Error('duplicate_model_entity');
  if (value.transport && (typeof value.transport.epoch !== 'string' ||
    !integer(value.transport.sequence) || typeof value.transport.eventId !== 'string')) throw new Error('invalid_model_transport');
  return value;
}

export function modelQuery(selection = {}) {
  const params = new URLSearchParams();
  for (const key of ['scope', 'session', 'checkpoint']) if (selection[key]) params.set(key, selection[key]);
  return params.size ? `?${params}` : '';
}

/** Hydrates one scope, not an unlimited project index. Every cursor is bound by
 * the server to the same revision, model sequence, policy fingerprint and epoch.
 */
export async function hydrateModel(raw, { request, selection = {}, signal,
  limits = VIEW_MODEL_LIMITS, maxBytes = 6 * 1024 * 1024, fetchPages = true } = {}) {
  readModel(raw);
  const result = { ...raw, coverage: { ...raw.coverage }, pages: { ...raw.pages } };
  let usedBytes = new TextEncoder().encode(JSON.stringify(raw)).length;
  let incomplete = false;
  const totals = {}, retained = {};
  for (const kind of COLLECTIONS) {
    const pageInfo = raw.pages?.[kind];
    if (pageInfo && (!integer(pageInfo.total) || pageInfo.total < raw[kind].length ||
      pageInfo.returned !== raw[kind].length)) throw new Error('invalid_model_pages');
    const values = raw[kind].slice(0, limits[kind]), seenIds = new Set(values.map(value => value.id));
    if (seenIds.size !== values.length) throw new Error('duplicate_model_record');
    totals[kind] = raw.pages?.[kind]?.total ?? raw[kind].length;
    let cursor = raw.pages?.[kind]?.nextCursor;
    const seenCursors = new Set();
    while (fetchPages && cursor && values.length < limits[kind] && usedBytes < maxBytes) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || seenCursors.has(cursor)) throw new Error('invalid_model_cursor');
      seenCursors.add(cursor);
      const params = new URLSearchParams(modelQuery(selection).slice(1));
      params.set('cursor', cursor); params.set('limit', String(Math.min(200, limits[kind] - values.length)));
      const page = await request(`/api/model/v1/${kind === 'checkpoints' ? 'history' : kind}?${params}`, { signal });
      if (signal?.aborted) throw new Error('model_request_cancelled');
      if (page?.projectId !== raw.projectId || page.revision !== raw.revision || page.sequence !== raw.sequence ||
        page.transport?.epoch !== raw.transport?.epoch ||
        JSON.stringify(page.selection) !== JSON.stringify(raw.selection)) throw stalePage();
      if (page.kind !== kind || !Array.isArray(page.items) || page.items.length > 200 ||
        page.page?.offset !== values.length || page.page.total !== totals[kind] ||
        page.page.returned !== page.items.length || (!page.items.length && page.page.nextCursor))
        throw new Error('invalid_model_page');
      const bytes = new TextEncoder().encode(jsonBytes(page, 512 * 1024)).length;
      if (usedBytes + bytes > maxBytes) { incomplete = true; break; }
      usedBytes += bytes;
      for (const value of page.items) {
        if (!id(value?.id) || seenIds.has(value.id)) throw new Error('duplicate_model_record');
        seenIds.add(value.id); values.push(value);
      }
      cursor = page.page.nextCursor;
      result.pages[kind] = { total: totals[kind], returned: values.length, nextCursor: cursor };
    }
    result[kind] = values;
    retained[kind] = values.length;
    if (values.length < totals[kind]) incomplete = true;
  }
  const ids = new Set(result.entities.map(entity => entity.id));
  const relations = result.relations.filter(relation => ids.has(relation.source) && ids.has(relation.target));
  const interpretations = result.interpretations.filter(value => value.entityIds?.every(id => ids.has(id)));
  if (relations.length !== result.relations.length || interpretations.length !== result.interpretations.length) incomplete = true;
  result.relations = relations; result.interpretations = interpretations;
  retained.relations = relations.length; retained.interpretations = interpretations.length;
  result.partial = incomplete;
  result.coverage.client = { truncated: incomplete, totals, retained };
  if (incomplete) result.coverage.truncated = true;
  return readModel(result);
}

export function createModelClient({ request, onSnapshot, onError = () => {}, Stream = globalThis.EventSource }) {
  let epoch = 0, update = 0, stream, controller, hydration, closed = false, selection = {}, latest = null, received = null;
  function stop() { update++; controller?.abort(); hydration?.abort(); stream?.close(); stream = null; }
  function duplicate(raw) {
    const previous = received || latest;
    if (!previous || previous.projectId !== raw.projectId) return false;
    if (raw.transport || previous.transport) return raw.transport?.epoch === previous.transport?.epoch &&
      raw.transport.sequence <= previous.transport.sequence;
    return raw.sequence <= previous.sequence;
  }
  async function accept(raw, streamed = false) {
    readModel(raw);
    if (streamed && duplicate(raw)) return;
    received = raw;
    hydration?.abort();
    const active = new AbortController(), mine = ++update;
    hydration = active;
    let model, current = raw;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        model = await hydrateModel(current, { request, selection, signal: active.signal });
        break;
      } catch (error) {
        if (active.signal.aborted || mine !== update || closed) return;
        if (error.status !== 409) throw error;
        current = await request(`/api/model/v1/snapshot${modelQuery(selection)}`, { signal: active.signal });
      }
    }
    // A continuously changing scope can invalidate all page cursors. Its fresh
    // first page is still consistent; retain it with explicit partial coverage.
    if (!model) model = await hydrateModel(current, { fetchPages: false });
    if (active.signal.aborted || mine !== update || closed) return;
    const sameEpoch = !latest?.transport || latest.transport.epoch === model.transport?.epoch;
    latest = model;
    received = model;
    onSnapshot(model, streamed && sameEpoch);
  }
  async function open(next = selection) {
    selection = { ...next };
    stop();
    const mine = ++epoch;
    controller = new AbortController();
    try {
      const model = await request(`/api/model/v1/snapshot${modelQuery(selection)}`, { signal: controller.signal });
      if (closed || mine !== epoch) return false;
      await accept(model);
      if (closed || mine !== epoch) return false;
      if (!selection.checkpoint && Stream) {
        const active = new Stream(`/api/model/v1/events${modelQuery(selection)}`, { withCredentials: true });
        stream = active;
        active.addEventListener('snapshot', event => {
          if (closed || stream !== active) return;
          try {
            if (event.data.length > 8 * 1024 * 1024) throw new Error('model_too_large');
            const raw = JSON.parse(event.data);
            if (event.lastEventId && raw.transport?.eventId !== event.lastEventId) throw new Error('invalid_model_event');
            void accept(raw, true).catch(() => onError('An invalid model update was ignored. Reconnect to restore the view.'));
          } catch { onError('An invalid model update was ignored. Reconnect to restore the view.'); }
        });
        active.addEventListener('reset', () => { if (stream === active) void open(); });
        for (const type of ['unavailable', 'closed', 'revoked', 'expired'])
          active.addEventListener(type, () => { if (stream === active) void open(); });
        active.addEventListener('error', () => {
          if (stream === active) onError('Model connection interrupted. The last received view is retained.');
        });
      }
      return true;
    } catch (error) {
      if (!closed && mine === epoch && ![404, 405].includes(error.status)) onError('Model views unavailable. The code map remains available.');
      return false;
    }
  }
  return { open, suspend() { epoch++; stop(); }, close() { closed = true; epoch++; stop(); } };
}
