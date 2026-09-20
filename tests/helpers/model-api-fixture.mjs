import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelAPI } from '../../runtime/daemon/model-api.mjs';

export const PREFIX = '/api/model/v1/';
export const projectId = 'project-synthetic';
export const fields = ['entities', 'relations', 'interpretations', 'activity', 'coverage', 'sessions', 'checkpoints'];
export const entity = (id, parentId = null) => ({ id, parentId, label: id, kind: 'module', basis: 'parsed',
  validity: 'current', sourceRefs: [{ artifactId: 'artifact-one', generation: 1, hash: 'a'.repeat(64) }] });
export function state() {
  return { schemaVersion: 2, projectId, revision: 1, sequence: 2,
    entities: [entity('root'), entity('alpha', 'root'), entity('child', 'alpha'), entity('beta', 'root')],
    relations: [{ id: 'relation-one', source: 'alpha', target: 'child', kind: 'contains', basis: 'parsed', validity: 'current' }],
    interpretations: [{ id: 'interpretation-one', namespace: 'example.layers', label: 'Application',
      kind: 'responsibility', entityIds: ['alpha'], basis: 'decision', support: 'tentative', validity: 'current', version: '1' }],
    activity: [{ id: 'event-one', sessionId: 'session-one', entityIds: ['alpha'], kind: 'tool.requested',
      sequence: 1, knownAtSequence: 1, at: '2026-01-01T00:00:00.000Z', outcome: 'pending', attribution: 'observed' },
    { id: 'event-two', sessionId: 'session-two', entityIds: ['beta'], kind: 'tool.succeeded',
      sequence: 2, knownAtSequence: 2, at: '2026-01-01T00:00:01.000Z', outcome: 'succeeded', attribution: 'correlated' }],
    coverage: { complete: false, inventoried: 12, inspected: 3, retained: 4, deferred: { entities: 7 },
      oldestSequence: 1, relationships: { observed: 2, resolved: 1, unresolved: 1 }, scopes: [{ id: 'root' }] },
    sessions: [{ id: 'session-one', host: 'codex', status: 'active' }, { id: 'session-two', host: 'claude', status: 'ended' }],
    checkpoints: [] };
}

export async function fixture(t, options = {}) {
  let current = state(), api, origin;
  const calls = [], checkpoints = new Map();
  const getSnapshot = selection => {
    calls.push({ ...selection });
    if (options.read) return options.read(selection, current, api);
    const selected = selection.checkpointId ? checkpoints.get(selection.checkpointId) : current;
    if (!selected) throw Object.assign(new Error('synthetic private message'), { code: 'MODEL_CHECKPOINT_UNAVAILABLE' });
    return structuredClone(selected);
  };
  api = createModelAPI({ projectId, getSnapshot, now: options.now,
    getSessions: options.getSessions,
    createCheckpoint: options.noCheckpoints ? undefined : input => {
      if (options.createCheckpoint) return options.createCheckpoint(input);
      const marker = { id: `checkpoint-${checkpoints.size + 1}`, projectId, revision: current.revision,
        sequence: ++current.sequence, label: input.label ?? 'Checkpoint', at: '2026-01-01T00:00:03.000Z',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
      current.checkpoints.push(marker);
      checkpoints.set(marker.id, structuredClone(current));
      return marker;
    } });
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') {
        res.writeHead(403); res.end(); return;
      }
      if (!await api.handle(req, res, { viewerAuthorized: req.headers.cookie === 'viewer=synthetic' })) {
        res.writeHead(404); res.end();
      }
    })().catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    api.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function request(route, { viewer = true, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + PREFIX + route, { method,
      headers: { ...(viewer ? { Cookie: 'viewer=synthetic' } : {}),
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, headers: response.headers, data, raw };
  }
  const post = (route, body, headers) => request(route, { method: 'POST', body, headers });
  async function grant(input = {}) {
    const result = await post('grants', { projectId, fields, history: true, ttlSeconds: 60, ...input });
    assert.equal(result.status, 201, result.raw);
    return { ...result.data, headers: { Authorization: `Bearer ${result.data.token}` } };
  }
  async function stream(route = 'events', headers = {}, viewer = true) {
    const events = [], pending = [];
    let ended = false, finish, response;
    const completion = new Promise(resolve => { finish = resolve; });
    const onEnd = () => {
      ended = true; finish();
      for (const waiter of pending.splice(0)) waiter(null);
    };
    const req = http.get(origin + PREFIX + route,
      { headers: { ...(viewer ? { Cookie: 'viewer=synthetic' } : {}), ...headers } });
    const ready = new Promise((resolve, reject) => {
      req.on('error', reject);
      req.on('response', res => {
        response = res;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!type || !data) continue;
            const event = { type, data: JSON.parse(data), id: /^id: (.+)$/m.exec(frame)?.[1], raw: frame };
            if (pending.length) pending.shift()(event); else events.push(event);
          }
        });
        res.on('end', onEnd); res.on('close', onEnd); res.on('error', onEnd);
        resolve(res);
      });
    });
    await ready;
    const stop = () => { req.destroy(); response?.destroy(); };
    t.after(stop);
    const next = async () => {
      if (events.length) return events.shift();
      if (ended) return null;
      let timer;
      try {
        return await Promise.race([new Promise(resolve => pending.push(resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stream event timeout')), 3000); })]);
      } finally { clearTimeout(timer); }
    };
    return { next, stop, completion, get status() { return response.statusCode; }, get ended() { return ended; } };
  }
  return { api, origin, server, request, post, grant, stream, calls, checkpoints,
    get state() { return current; }, set state(value) { current = value; } };
}
export const cursorQuery = cursor => encodeURIComponent(cursor);
