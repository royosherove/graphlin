import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { createModelAPI } from '../../runtime/daemon/model-api.mjs';
import { compareCheckpoint } from '../../runtime/model/changes.mjs';

const PREFIX = '/api/model/v1/';
const projectId = 'project-synthetic';
const fields = ['entities', 'relations', 'interpretations', 'activity', 'coverage', 'sessions', 'checkpoints'];
const entity = (id, parentId = null) => ({ id, parentId, label: id, kind: 'module', basis: 'parsed',
  validity: 'current', sourceRefs: [{ artifactId: 'artifact-one', generation: 1, hash: 'a'.repeat(64) }] });
const certificate = (changes = {}) => ({
  artifactId: 'artifact-one', scopeId: 'root', hash: 'a'.repeat(64), generation: 1,
  complete: true, extractor: 'tree-sitter', version: '@vscode/tree-sitter-wasm@0.3.1/javascript/pinned',
  identityVersion: 'identity-1', coveredRanges: [{ startLine: 1, endLine: 50 }], omissions: [], capability: 'parsed',
  ...changes,
});
function state() {
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

async function fixture(t, options = {}) {
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
const cursorQuery = cursor => encodeURIComponent(cursor);

test('standalone integration: route ownership, negotiated capabilities and outer Host guard', async t => {
  const f = await fixture(t);
  assert.equal(await f.api.handle({ url: '/api/state' }, {}), false);
  const result = await f.request('bootstrap');
  assert.equal(result.status, 200);
  assert.equal(result.data.schemaVersion, 2);
  assert.equal(result.data.capabilities.apiVersion, 1);
  assert.equal(result.data.capabilities.limits.payloadBytes, 512 * 1024);
  assert.equal(result.data.capabilities.checkpointCreation, true);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  const wrongHost = await new Promise(resolve => {
    http.get(f.origin + PREFIX + 'snapshot', { headers: { Host: 'wrong.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request('snapshot', { viewer: false })).status, 401);
  assert.equal((await f.request('control')).status, 404);
  assert.deepEqual(f.calls[0], { persistent: false });
});

test('session, scope and checkpoint selection never change another viewer', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.request('snapshot?session=session-one&scope=alpha'),
    f.request('snapshot?session=session-two&scope=beta')]);
  assert.deepEqual(one.data.entities.map(e => e.id), ['root', 'alpha', 'child']);
  assert.deepEqual(two.data.entities.map(e => e.id), ['root', 'beta']);
  assert.deepEqual(one.data.activity.map(e => e.id), ['event-one']);
  assert.deepEqual(two.data.activity.map(e => e.id), ['event-two']);
  assert.equal(two.data.relations.length, 0);
  assert.equal(two.data.interpretations.length, 0);
  assert.equal((await f.request('snapshot')).data.activity.length, 2);
  assert.deepEqual(f.calls[0], { scopeId: 'alpha', sessionId: 'session-one', persistent: false });
  assert.equal((await f.request('entities/alpha')).data.entity.id, 'alpha');
  assert.deepEqual((await f.request('entities/alpha/children')).data.items.map(e => e.id), ['child']);
  assert.equal((await f.request('snapshot?scope=missing')).status, 404);
});

test('strict bounded queries, methods, labels and JSON', async t => {
  const f = await fixture(t);
  for (const route of ['snapshot?token=hidden', 'snapshot?scope=a&scope=b', 'snapshot?scope=',
    'snapshot?scope=%2Fetc%2Fsynthetic', 'snapshot?limit=0', 'snapshot?limit=201',
    'snapshot?limit=01', 'snapshot?limit=1.5', 'snapshot?limit=NaN', 'snapshot?persistent=true',
    'capabilities?scope=root', 'history?kind=raw', 'entities?cursor=%', 'entities/root?cursor=ignored',
    `snapshot?scope=${'a'.repeat(4096)}`, 'snapshot?scope=%ff']) {
    const response = await f.request(route);
    assert.equal(response.status, 400, route);
  }
  for (const body of ['[]', 'null', '{"label":"one","label":"two"}',
    '{"label":"one","\\u006cabel":"two"}', '{"label":false}', '{"label":"Code","raw":"bad"}', '{']) {
    const response = await f.post('checkpoints', body);
    assert.equal(response.status, 400, body);
  }
  assert.equal((await f.post('checkpoints', '{"label":"' + 'a'.repeat(4100) + '"}')).status, 413);
  assert.equal((await f.post('checkpoints', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('checkpoints', {}, { Origin: 'null' })).status, 403);
  assert.equal((await f.post('checkpoints', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.post('checkpoints', {}, { Origin: f.origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('snapshot', { method: 'DELETE' })).status, 404);
});

test('chunked oversized JSON returns a bounded error instead of processing a partial grant', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.origin + PREFIX + 'grants', { method: 'POST',
      headers: { Cookie: 'viewer=synthetic', Origin: f.origin, 'Content-Type': 'application/json' } },
    res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"label":"'); req.end('a'.repeat(5000) + '"}');
  });
  assert.equal(status, 413);
});

test('20k inventory snapshots and every page stay bounded and all entities remain reachable', async t => {
  const f = await fixture(t);
  let recordEncodings = 0, pages = 1;
  const stringify = JSON.stringify, started = performance.now();
  // A recording mock would retain every full snapshot and encoded string.
  t.after(() => { JSON.stringify = stringify; });
  JSON.stringify = function (value, ...args) {
    if (value && typeof value.id === 'string' &&
        (Object.hasOwn(value, 'sourceRefs') || Object.hasOwn(value, 'source'))) recordEncodings++;
    return Reflect.apply(stringify, this, [value, ...args]);
  };
  f.state.entities = Array.from({ length: 20_000 }, (_, i) => entity(`node-${String(i).padStart(5, '0')}`));
  f.state.relations = Array.from({ length: 40_000 }, (_, i) => ({ id: `edge-${String(i).padStart(5, '0')}`,
    source: 'node-00000', target: 'node-00001', kind: 'calls' }));
  const snapshot = await f.request('snapshot');
  assert.equal(snapshot.status, 200, snapshot.raw.slice(0, 100));
  assert.equal(snapshot.data.partial, true);
  assert.equal(snapshot.data.pages.entities.total, 20_000);
  assert.equal(snapshot.data.pages.relations.total, 40_000);
  assert.ok(snapshot.data.activity.length);
  assert.ok(Buffer.byteLength(snapshot.raw) <= 512 * 1024);
  assert.ok(['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints']
    .reduce((sum, field) => sum + snapshot.data[field].length, 0) <= 200);
  const ids = new Set(snapshot.data.entities.map(value => value.id));
  let cursor = snapshot.data.pages.entities.nextCursor;
  while (cursor) {
    const page = await f.request(`entities?cursor=${cursorQuery(cursor)}`);
    pages++;
    assert.equal(page.status, 200, page.raw.slice(0, 100));
    assert.ok(page.data.items.length <= 200);
    assert.ok(Buffer.byteLength(page.raw) <= 512 * 1024);
    assert.equal(page.data.revision, snapshot.data.revision);
    for (const value of page.data.items) { assert.equal(ids.has(value.id), false); ids.add(value.id); }
    cursor = page.data.page.nextCursor;
  }
  assert.equal(ids.size, 20_000);
  assert.equal(f.calls.length, pages, 'every page reads the current provider, even with unchanged revision');
  assert.ok(recordEncodings < 3 * (20_000 + 40_000),
    `unchanged records must not be reprojected/encoded on every page: ${recordEncodings} encodings`);
  t.diagnostic(`20k entity walk: ${pages} requests, ${recordEncodings} record encodings, ${(performance.now() - started).toFixed(0)} ms`);
});

test('byte-limited interpretation pages trim with advancing cursors and visible coverage', async t => {
  const f = await fixture(t);
  const members = Array.from({ length: 256 }, (_, i) => `member-${i}-${'m'.repeat(130)}`);
  f.state.interpretations = Array.from({ length: 200 }, (_, i) => ({
    id: `large-${i}`, namespace: 'example.large', entityIds: members, label: 'Large group', support: 'tentative',
  }));
  const page = await f.request('interpretations');
  assert.equal(page.status, 200);
  assert.ok(page.data.items.length > 0 && page.data.items.length < 200);
  assert.ok(Buffer.byteLength(page.raw) <= 512 * 1024);
  const next = await f.request(`interpretations?cursor=${cursorQuery(page.data.page.nextCursor)}`);
  assert.equal(next.data.page.offset, page.data.items.length);
  const stream = await f.stream();
  const event = await stream.next();
  assert.equal(event.type, 'snapshot');
  assert.ok(Buffer.byteLength(event.raw + '\n\n') <= 512 * 1024);
  assert.equal(event.data.partial, true);
});

test('bounded scope snapshots keep every retained ancestor before its child', async t => {
  const f = await fixture(t);
  f.state.entities = [entity('z-root'), ...Array.from({ length: 500 }, (_, i) => entity(`child-${i}`, 'z-root'))];
  const initial = await f.request('snapshot?scope=z-root&limit=12');
  const visible = initial.data.entities;
  assert.equal(visible[0].id, 'z-root');
  const seen = new Set();
  for (const value of visible) {
    if (value.parentId) assert.ok(seen.has(value.parentId));
    seen.add(value.id);
  }
  assert.equal(initial.data.pages.entities.total, 501);
  const next = await f.request(`entities?scope=z-root&cursor=${cursorQuery(initial.data.pages.entities.nextCursor)}`);
  assert.equal(next.status, 200);
  assert.equal(next.data.page.offset, visible.length);
  assert.ok(next.data.items.every(e => e.parentId === 'z-root'));
});

test('revision, activity, projection-policy and expiry changes invalidate page cursors', async t => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock });
  const first = () => f.request('entities?limit=1');
  const use = value => f.request(`entities?cursor=${cursorQuery(value.data.page.nextCursor)}`);
  let before = await first();
  assert.equal((await use(before)).status, 200);
  f.state.revision++;
  assert.equal((await use(before)).data.error, 'stale_cursor');
  before = await first(); f.state.sequence++;
  assert.equal((await use(before)).status, 409);
  before = await first(); f.state.entities[0].label = 'Redacted';
  assert.equal((await use(before)).status, 409);
  before = await first(); clock += 300_001;
  assert.equal((await use(before)).status, 409);
});

test('cached records recheck nested evidence, removed and newly added fields without revision or notify', async t => {
  const f = await fixture(t, { read: (_selection, current) => current });
  const first = () => f.request('entities?limit=1');
  const use = value => f.request(`entities?cursor=${cursorQuery(value.data.page.nextCursor)}`);
  const mutations = [
    () => { f.state.entities[0].sourceRefs[0].generation++; },
    () => { f.state.entities[0].sourceRefs[0].hash = 'b'.repeat(64); },
    () => { f.state.entities[0].createdAtSequence = 1; },
    () => { delete f.state.entities[0].label; },
    () => { f.state.relations[0].target = 'beta'; },
    () => { f.state.interpretations[0].entityIds.push('beta'); },
    () => { f.state.entities[0].sourceRefs[0].hash = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const baseline = await first();
    assert.equal(baseline.status, 200);
    assert.equal((await use(baseline)).status, 200, 'warm the cache');
    mutate();
    const changed = await use(baseline);
    assert.equal(changed.status, 409, changed.raw);
    assert.equal(changed.data.error, 'stale_cursor');
  }
  assert.equal((await f.request('entities/root')).status, 404, 'invalid support cannot reuse its old valid record');
});

test('cached JSON records enforce support guards even for fields outside their record schema', async t => {
  const f = await fixture(t);
  await f.post('checkpoints', { label: 'Guard fixture' });
  const cases = [
    ['entities', ['entityIds', 'artifactIds']],
    ['relations', ['entityIds', 'artifactIds']],
    ['interpretations', ['artifactIds']],
    ['sessions', ['sourceRefs', 'entityIds', 'artifactIds']],
    ['checkpoints', ['sourceRefs', 'entityIds', 'artifactIds']],
  ];
  for (const [kind, fields] of cases) for (const field of fields) {
    const target = f.state[kind][0], id = target.id;
    const baseline = await f.request('entities?limit=1');
    target[field] = [];
    const changed = await f.request(`entities?cursor=${cursorQuery(baseline.data.page.nextCursor)}`);
    assert.equal(changed.status, 409, `${kind}.${field} must invalidate the cached cursor`);
    const warm = await f.request('snapshot');
    assert.ok(!warm.data[kind].some(value => value.id === id), `${kind}.${field} must drop the invalid record`);
    f.api.notify();
    const cold = await f.request('snapshot');
    assert.deepEqual(warm.data[kind], cold.data[kind], 'cache reuse must agree with fresh record validation');
    assert.deepEqual(warm.data.coverage.projection, cold.data.coverage.projection);
    delete target[field];
  }
});

test('cached refs validate newly inherited and non-enumerable known fields including absent optional metadata', async t => {
  const f = await fixture(t, { read: (_selection, current) => current });
  const fields = {
    artifactId: 'artifact-two', eventId: 'event-extra', generation: 2, hash: 'b'.repeat(64),
    startLine: 1, endLine: 3, sourceClass: 'source', extractor: 'parser',
    extractorVersion: 'version-2', identityVersion: 'identity-2',
  };
  for (const mode of ['inherited', 'non-enumerable']) for (const [field, valid] of Object.entries(fields)) {
    for (const value of [valid, 'INVALID REF=RAW_SENTINEL']) {
      f.state = state();
      const base = field === 'artifactId' ? { eventId: 'event-base' } : { artifactId: 'artifact-one' };
      f.state.entities[0].sourceRefs = [{ ...base }];
      const baseline = await f.request('entities?limit=1');
      const ref = mode === 'inherited' ? Object.assign(Object.create({ [field]: value }), base) : { ...base };
      if (mode === 'non-enumerable') Object.defineProperty(ref, field, { value, enumerable: false });
      f.state.entities[0].sourceRefs = [ref];
      const changed = await f.request(`entities?cursor=${cursorQuery(baseline.data.page.nextCursor)}`);
      assert.equal(changed.status, 409, `${mode} ${field} must revalidate without revision or notify`);
      const warm = await f.request('entities/root');
      assert.equal(warm.status, value === valid ? 200 : 404);
      if (value === valid) assert.equal(warm.data.entity.sourceRefs[0][field], value);
      assert.doesNotMatch(warm.raw, /RAW_SENTINEL/);
      f.api.notify();
      const cold = await f.request('entities/root');
      assert.equal(warm.status, cold.status);
      assert.deepEqual(warm.data.entity, cold.data.entity);
    }
  }
});

test('cached projection never serializes unsupported raw fields or restores withheld labels for another grant', async t => {
  const f = await fixture(t, { read: (_selection, current) => current });
  const first = await f.request('entities?limit=1');
  const cursor = first.data.page.nextCursor;
  const raw = { bigint: 1n };
  raw.cycle = raw;
  Object.defineProperty(raw, 'toJSON', { get() { throw new Error('RAW_SENTINEL'); } });
  for (const value of [...f.state.entities, ...f.state.interpretations]) value['extension.raw'] = raw;
  f.state.storage = raw;
  const unchanged = await f.request(`entities?cursor=${cursorQuery(cursor)}`);
  assert.equal(unchanged.status, 200, unchanged.raw);
  assert.doesNotMatch(unchanged.raw, /RAW_SENTINEL/);
  f.state.entities[0].label = 'API_KEY=RAW_SENTINEL';
  const redacted = await f.request('snapshot');
  assert.equal(redacted.data.entities.find(value => value.id === 'root').label, undefined);
  assert.doesNotMatch(redacted.raw, /RAW_SENTINEL/);
  const grant = await f.grant({ fields: ['activity'], history: false });
  const restricted = await f.request('snapshot', { viewer: false, headers: grant.headers });
  assert.deepEqual(restricted.data.entities, []);
  assert.deepEqual(restricted.data.interpretations, []);
  assert.doesNotMatch(restricted.raw, /RAW_SENTINEL/);
});

test('cached snapshots still refresh fallback sessions and reject duplicate identities and containment cycles', async t => {
  let sessions = [{ id: 'session-one', status: 'active' }];
  const f = await fixture(t, { getSessions: () => sessions });
  delete f.state.sessions;
  const first = await f.request('entities?limit=1');
  sessions = [{ id: 'session-two', status: 'active' }];
  assert.equal((await f.request(`entities?cursor=${cursorQuery(first.data.page.nextCursor)}`)).status, 409);
  f.state.relations.push(structuredClone(f.state.relations[0]));
  assert.equal((await f.request('entities')).data.error, 'duplicate_model_identity');
  f.state.relations.pop();
  f.state.entities[0].parentId = 'child';
  assert.equal((await f.request('entities')).data.error, 'invalid_model_containment');
});

test('cursors cannot cross principals, collections, parents, scopes or be forged', async t => {
  const f = await fixture(t);
  const response = await f.request('entities?limit=1');
  const cursor = response.data.page.nextCursor;
  assert.equal((await f.request(`relations?cursor=${cursorQuery(cursor)}`)).status, 400);
  assert.equal((await f.request(`entities?scope=root&cursor=${cursorQuery(cursor)}`)).status, 400);
  assert.equal((await f.request(`entities/root/children?cursor=${cursorQuery(cursor)}`)).status, 400);
  assert.equal((await f.request(`entities?cursor=${cursorQuery(cursor.slice(0, -2) + 'xx')}`)).status, 400);
  const grant = await f.grant();
  assert.equal((await f.request(`entities?cursor=${cursorQuery(cursor)}`,
    { viewer: false, headers: grant.headers })).status, 400);
  const children = await f.request('entities/root/children?limit=1');
  const continued = await f.request(`entities/root/children?cursor=${cursorQuery(children.data.page.nextCursor)}`);
  assert.equal(continued.status, 200);
  assert.equal(continued.data.items[0].id, 'beta');
});

test('frozen checkpoints preserve old structure, interpretations, sessions and revision', async t => {
  const f = await fixture(t);
  const created = await f.post('checkpoints', { label: 'Before task' });
  assert.equal(created.status, 201);
  const marker = created.data.checkpoint;
  f.state.entities.push(entity('new-entity'));
  f.state.interpretations[0].label = 'New interpretation';
  f.state.sessions = [{ id: 'new-session' }];
  f.state.revision++; f.state.sequence++;
  const before = await f.request(`snapshot?checkpoint=${marker.id}`);
  assert.equal(before.status, 200);
  assert.equal(before.data.revision, marker.revision);
  assert.equal(before.data.sequence, marker.sequence);
  assert.equal(before.data.entities.some(e => e.id === 'new-entity'), false);
  assert.equal(before.data.interpretations[0].label, 'Application');
  assert.equal(before.data.sessions.length, 2);
  const history = await f.request('history');
  assert.equal(history.data.items[0].label, 'Before task');
  assert.equal((await f.request('history?kind=activity&limit=1')).data.items[0].outcome, 'pending');
  assert.equal((await f.request('snapshot?checkpoint=missing')).data.error, 'checkpoint_unavailable');
});

test('lineage projection preserves recorded checkpoint branch and HEAD in scoped reads and streams', async t => {
  const f = await fixture(t);
  const before = { id: 'lineage-before', status: 'git', branch: 'feature/before', head: 'a'.repeat(40) };
  const after = { id: 'lineage-after', status: 'git', branch: 'feature/after', head: 'B'.repeat(64) };
  f.state.coverage.lineage = { ...before, source: 'RAW_SENTINEL', 'extension.raw': { secret: 'RAW_SENTINEL' } };
  const created = await f.post('checkpoints', { label: 'Before branch change' });
  assert.equal(created.status, 201);
  const route = `snapshot?checkpoint=${created.data.checkpoint.id}&scope=alpha`;
  const frozen = await f.request(route);
  assert.equal(frozen.status, 200);
  assert.deepEqual(frozen.data.coverage.lineage, before);
  assert.doesNotMatch(frozen.raw, /RAW_SENTINEL/);
  const stream = await f.stream(route.replace('snapshot?', 'events?'));
  const initial = await stream.next();
  assert.deepEqual(initial.data.coverage.lineage, before);
  assert.doesNotMatch(initial.raw, /RAW_SENTINEL/);
  f.state.coverage.lineage = after;
  f.api.notify();
  const updated = await stream.next();
  assert.deepEqual(updated.data.coverage.lineage, before);
  assert.doesNotMatch(updated.raw, /RAW_SENTINEL/);
  assert.deepEqual((await f.request(route)).data.coverage.lineage, before);
  assert.deepEqual((await f.request('snapshot?scope=alpha')).data.coverage.lineage, after);
  const grant = await f.grant({ fields: ['entities'] });
  const restricted = await f.request('snapshot', { viewer: false, headers: grant.headers });
  assert.equal(restricted.data.coverage.lineage, undefined);
});

test('lineage is bounded metadata with required identity and exact status, never raw provider data', async t => {
  const f = await fixture(t);
  for (const status of ['git', 'not_git', 'unavailable']) {
    const minimal = { id: `lineage-${status}`, status };
    f.state.coverage.lineage = minimal;
    assert.deepEqual((await f.request('snapshot')).data.coverage.lineage, minimal);
    f.state.coverage.lineage = { ...minimal, branch: 'API_KEY=RAW_SENTINEL', head: 'a'.repeat(41),
      stderr: 'RAW_SENTINEL', repository: '/Users/synthetic/.env', 'extension.raw': { source: 'RAW_SENTINEL' } };
    const stripped = await f.request('snapshot');
    assert.deepEqual(stripped.data.coverage.lineage, minimal);
    assert.doesNotMatch(stripped.raw, /RAW_SENTINEL|\/Users\/synthetic/);
  }
  for (const branch of ['x'.repeat(4096), 'branch\nRAW_SENTINEL', '<script>RAW_SENTINEL</script>', { raw: 'RAW_SENTINEL' }]) {
    f.state.coverage.lineage = { id: 'lineage-bounded', status: 'git', branch, head: 'g'.repeat(64) };
    assert.deepEqual((await f.request('snapshot')).data.coverage.lineage, { id: 'lineage-bounded', status: 'git' });
  }
  for (const invalid of [null, [], 'RAW_SENTINEL', {}, { id: 'lineage-one' }, { status: 'git' },
    { id: 'lineage-one', status: 'GIT' }, { id: 'lineage-one', status: 'unknown' },
    { id: 'x'.repeat(161), status: 'git' }, { id: '/Users/synthetic', status: 'git' }]) {
    f.state.coverage.lineage = invalid;
    assert.equal((await f.request('snapshot')).data.coverage.lineage, undefined);
  }
});

test('lineage-only changes invalidate old page assembly without inferring model freshness', async t => {
  const f = await fixture(t);
  f.state.coverage.lineage = { id: 'lineage-one', status: 'git', head: 'a'.repeat(40) };
  const first = await f.request('entities?limit=1');
  f.state.coverage.lineage = { id: 'lineage-two', status: 'unavailable' };
  const continued = await f.request(`entities?cursor=${cursorQuery(first.data.page.nextCursor)}`);
  assert.equal(continued.status, 409);
  assert.equal(continued.data.error, 'stale_cursor');
  const snapshot = (await f.request('snapshot')).data;
  assert.deepEqual(snapshot.coverage.lineage, f.state.coverage.lineage);
  assert.equal(snapshot.revision, first.data.revision);
  assert.equal(snapshot.sequence, first.data.sequence);
  assert.ok(snapshot.entities.every(value => value.validity === 'current'));
});

test('transport preserves creation markers, validated enumeration proof and honest parsing counts', async t => {
  const f = await fixture(t);
  f.state.coverage.enumerations = [certificate()];
  f.state.coverage.parsing = { queued: 3, active: 1, deferred: 2, parsed: 4, failed: 1, stale: 2, omitted: 3,
    lastError: 'parse.revalidation_failed', source: 'RAW_SENTINEL' };
  const baseline = (await f.request('snapshot')).data;
  assert.deepEqual(baseline.coverage.enumerations, [certificate()]);
  const byProof = { ...entity('created-from-complete-proof'), artifactId: 'artifact-one' };
  const byEvent = { ...entity('created-from-observation'), artifactId: 'artifact-two', createdAtSequence: 3 };
  f.state.entities.push(byProof, byEvent);
  f.state.sequence = 3; f.state.revision++;
  f.state.coverage.enumerations = [certificate({ generation: 2, hash: 'b'.repeat(64) })];
  const current = (await f.request('snapshot')).data;
  assert.equal(current.entities.find(value => value.id === byEvent.id).createdAtSequence, 3);
  assert.deepEqual(compareCheckpoint(baseline, current, 'baseline').creations.map(value => value.id).sort(),
    [byProof.id, byEvent.id].sort());
  assert.equal(current.coverage.parsing.queued, 3);
  assert.equal(current.coverage.parsing.active, 1);
  assert.equal(current.coverage.parsing.lastError, 'parse.revalidation_failed');
  assert.equal(current.coverage.parsing.source, undefined);
  const stream = await f.stream();
  assert.deepEqual((await stream.next()).data.coverage.enumerations, current.coverage.enumerations);
  const page = await f.request(`entities/${byEvent.id}`);
  assert.equal(page.data.entity.createdAtSequence, 3);
});

test('enumeration projection never invents complete proof or exports raw nested fields', async t => {
  const f = await fixture(t);
  const safe = certificate({ raw: 'RAW_SENTINEL',
    coveredRanges: [{ startLine: 1, endLine: 50, source: 'RAW_SENTINEL' }],
    'extension.secret': { source: 'RAW_SENTINEL' } });
  f.state.coverage.enumerations = [safe,
    certificate({ artifactId: 'partial', omissions: ['partial_capture'] }),
    certificate({ artifactId: 'lexical', capability: 'lexical' }),
    certificate({ artifactId: 'unknown-scheme', version: 'unknown' }),
    certificate({ artifactId: 'bad-range', coveredRanges: [{ startLine: 0, endLine: 10 }] }),
    certificate({ artifactId: 'bad-version', version: 'API_KEY=RAW_SENTINEL' }),
    certificate({ artifactId: 'too-many-ranges', coveredRanges: Array(129).fill({ startLine: 1, endLine: 10 }) }),
    certificate({ artifactId: 'duplicate' }), certificate({ artifactId: 'duplicate', generation: 2 })];
  const response = await f.request('snapshot');
  assert.doesNotMatch(response.raw, /RAW_SENTINEL/);
  assert.deepEqual(response.data.coverage.enumerations.find(value => value.artifactId === 'artifact-one'), certificate());
  assert.ok(response.data.coverage.enumerations.filter(value => value.artifactId !== 'artifact-one')
    .every(value => value.complete === false));
  assert.equal(response.data.coverage.enumerationCoverage.omitted, 5);
  assert.equal(response.data.coverage.enumerationCoverage.truncated, true);
});

test('enumeration certificates obey count, bytes, scope and combined snapshot record budgets', async t => {
  const f = await fixture(t);
  f.state.coverage.enumerations = Array.from({ length: 200 }, (_, index) => certificate({ artifactId: `artifact-${index}` }));
  f.state.entities[0].artifactId = 'artifact-0';
  const full = await f.request('snapshot');
  assert.equal(full.data.coverage.enumerations.length, 64);
  assert.equal(full.data.coverage.enumerationCoverage.total, 200);
  assert.equal(full.data.coverage.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(full.data.coverage.enumerations)) <= 64 * 1024);
  const limited = await f.request('snapshot?limit=5');
  assert.ok(limited.data.coverage.enumerations.length +
    ['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints']
      .reduce((sum, field) => sum + limited.data[field].length, 0) <= 5);
  const scoped = await f.request('snapshot?scope=root');
  assert.equal(scoped.data.coverage.enumerations.length, 1);
  assert.equal(scoped.data.coverage.enumerations[0].artifactId, 'artifact-0');
  const grant = await f.grant({ fields: ['entities'] });
  const denied = await f.request('snapshot', { viewer: false, headers: grant.headers });
  assert.equal(denied.data.coverage.enumerations, undefined);
});

test('checkpoint callback is optional and capacity errors never reveal provider messages', async t => {
  const disabled = await fixture(t, { noCheckpoints: true });
  assert.equal((await disabled.request('capabilities')).data.checkpointCreation, false);
  assert.equal((await disabled.post('checkpoints', {})).status, 501);
  const full = await fixture(t, { createCheckpoint: () => {
    throw Object.assign(new Error('PRIVATE SOURCE MUST NOT EGRESS'), { code: 'MODEL_CHECKPOINT_CAPACITY' });
  } });
  const result = await full.post('checkpoints', {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.data, { error: 'checkpoint_capacity' });
});

test('safe projection strips raw fields even inside named extension namespaces and history', async t => {
  const f = await fixture(t);
  const raw = { excerpt: 'RAW_SENTINEL', source: 'RAW_SENTINEL', snippets: ['RAW_SENTINEL'],
    raw: { prompt: 'RAW_SENTINEL' }, credentials: 'RAW_SENTINEL', transcript: 'RAW_SENTINEL',
    'extension.custom': { nested: { text: 'RAW_SENTINEL' } } };
  for (const kind of ['entities', 'relations', 'interpretations', 'activity', 'sessions']) {
    for (const value of f.state[kind]) Object.assign(value, raw, kind === 'relations' ? { source: 'alpha' } : {});
  }
  f.state.entities[0].label = 'API_KEY=synthetic-secret';
  f.state.entities[1].relativePath = '/home/synthetic/private.mjs';
  f.state.entities[2].sourceRefs[0].excerpt = 'RAW_SENTINEL';
  f.state.entities[3].qualifiedName = 'const credential = "RAW_SENTINEL";';
  Object.assign(f.state.coverage, raw);
  f.state.coverage.scopes = [{ label: 'RAW_SENTINEL', payload: raw }];
  f.state.coverage.deferred.source = raw;
  f.state.namespaces = raw;
  f.state.storage = { state: raw, privateSnapshot: 'RAW_SENTINEL' };
  f.state.coverage.relationships.secret = raw;
  await f.post('checkpoints', { label: 'Safe marker' });
  const stored = f.checkpoints.get('checkpoint-1');
  stored.checkpoints[0].state = raw;
  for (const route of ['bootstrap', 'snapshot', 'entities', 'entities/root', 'entities/root/children',
    'relations', 'interpretations', 'activity', 'sessions', 'history', 'history?kind=activity',
    'snapshot?checkpoint=checkpoint-1']) {
    const result = await f.request(route);
    assert.equal(result.status, 200, `${route}: ${result.raw}`);
    assert.doesNotMatch(result.raw, /RAW_SENTINEL|synthetic-secret|\/home\/synthetic|const credential/);
  }
  const grant = await f.grant();
  const stream = await f.stream('events', grant.headers, false);
  assert.doesNotMatch((await stream.next()).raw, /RAW_SENTINEL|synthetic-secret|\/home\/synthetic/);
});

test('invalid/async providers, duplicate records and wrong projects fail without private errors', async t => {
  for (const read of [
    () => ({ ...state(), projectId: 'another-project' }),
    () => Promise.resolve(state()),
    () => { throw new Error('PRIVATE_SENTINEL'); },
    () => { throw { status: 400, code: 'PRIVATE_SENTINEL' }; },
    () => ({ ...state(), entities: [entity('duplicate'), entity('duplicate')] }),
    () => ({ ...state(), entities: [entity('cycle-one', 'cycle-two'), entity('cycle-two', 'cycle-one')] }),
  ]) {
    const f = await fixture(t, { read });
    const result = await f.request('snapshot');
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.raw, /PRIVATE_SENTINEL|another-project/);
  }
});

test('optional session callback is synchronous and is never used to modernize a checkpoint', async t => {
  let calls = 0;
  const f = await fixture(t, { getSessions: () => { calls++; return [{ id: 'fallback-session' }]; } });
  delete f.state.sessions;
  assert.equal((await f.request('sessions')).data.items[0].id, 'fallback-session');
  await f.post('checkpoints', {});
  assert.equal((await f.request('snapshot?checkpoint=checkpoint-1')).data.sessions.length, 0);
  assert.equal(calls, 1);
});

test('stream advances for activity-only changes while keeping semantic revision fixed', async t => {
  const f = await fixture(t);
  f.state.entities = []; f.state.relations = []; f.state.interpretations = [];
  const stream = await f.stream('events?session=session-one');
  const first = await stream.next();
  f.state.sequence++;
  f.state.activity.push({ id: 'completion', sessionId: 'session-one', kind: 'tool.succeeded',
    sequence: f.state.sequence, outcome: 'succeeded', at: '2026-01-01T00:00:02.000Z' });
  f.api.notify();
  const second = await stream.next();
  assert.equal(second.type, 'snapshot');
  assert.equal(second.data.revision, first.data.revision);
  assert.equal(second.data.activity.length, 2);
  assert.ok(second.data.transport.sequence > first.data.transport.sequence);
  assert.notEqual(second.id, first.id);
});

test('an update during initial snapshot acquisition is delivered after the initial snapshot', async t => {
  let once = true;
  const f = await fixture(t, { read: (_selection, current, api) => {
    const before = structuredClone(current);
    if (once) {
      once = false;
      current.entities.push(entity('arrived-during-snapshot')); current.sequence++;
      api.notify();
    }
    return before;
  } });
  const stream = await f.stream();
  const first = await stream.next(), second = await stream.next();
  assert.equal(first.data.entities.some(e => e.id === 'arrived-during-snapshot'), false);
  assert.equal(second.data.entities.some(e => e.id === 'arrived-during-snapshot'), true);
  assert.ok(second.data.transport.sequence > first.data.transport.sequence);
});

test('resume validates retained positions and coalesces into a newly projected full snapshot', async t => {
  const f = await fixture(t);
  const stream = await f.stream(), first = await stream.next();
  stream.stop();
  for (let i = 0; i < 3; i++) { f.state.sequence++; f.api.notify(); }
  f.state.entities[0].label = 'Redacted';
  const resumed = await f.stream('events', { 'Last-Event-ID': first.id });
  const event = await resumed.next();
  assert.equal(event.type, 'snapshot');
  assert.deepEqual(event.data.transport.resume, { fromSequence: first.data.transport.sequence, coalesced: true });
  assert.equal(event.data.entities.find(e => e.id === 'root').label, 'Redacted');
  assert.equal(event.data.transport.sequence, first.data.transport.sequence + 3);
});

test('evicted, future, malformed and cross-selection stream positions reset with retained bounds', async t => {
  const f = await fixture(t);
  const stream = await f.stream(), initial = await stream.next(); stream.stop();
  for (let i = 0; i < 140; i++) f.api.notify();
  for (const last of [initial.id, initial.id.replace(':1:', ':999999:'), 'bad-position']) {
    const resumed = await f.stream('events', { 'Last-Event-ID': last });
    const reset = await resumed.next();
    assert.equal(reset.type, 'reset');
    assert.ok(reset.data.oldestSequence > 1);
    assert.equal(reset.data.latestSequence - reset.data.oldestSequence, 127);
    assert.equal((await resumed.next()).type, 'snapshot');
    resumed.stop();
  }
  const selected = await f.stream('events?session=session-one', { 'Last-Event-ID': initial.id });
  assert.equal((await selected.next()).data.reason, 'wrong_lineage');
});

test('checkpoint streams remain frozen on subsequent notifications', async t => {
  const f = await fixture(t);
  const marker = (await f.post('checkpoints', {})).data.checkpoint;
  const stream = await f.stream(`events?checkpoint=${marker.id}`);
  const first = await stream.next();
  f.state.revision++; f.state.sequence++; f.state.entities = [entity('different')];
  f.api.notify();
  const second = await stream.next();
  assert.deepEqual(second.data.entities, first.data.entities);
  assert.equal(second.data.sequence, marker.sequence);
});

test('native grants restrict fields and history and never acquire host authority', async t => {
  const f = await fixture(t);
  await f.post('checkpoints', {});
  const grant = await f.grant({ fields: ['entities'], history: false });
  const options = { viewer: false, headers: grant.headers };
  const snapshot = await f.request('snapshot', options);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.entities.length, 4);
  for (const field of ['activity', 'relations', 'interpretations', 'sessions', 'checkpoints']) assert.deepEqual(snapshot.data[field], []);
  for (const route of ['activity', 'history', 'snapshot?checkpoint=checkpoint-1', 'snapshot?session=session-one']) {
    assert.equal((await f.request(route, options)).status, 403);
  }
  for (const route of ['checkpoints', 'grants', 'grants/revoke', 'control', 'install', 'capture']) {
    assert.equal((await f.request(route, { ...options, viewer: true, method: 'POST', body: {} })).status, 403);
  }
  assert.equal((await f.request('snapshot?token=' + grant.token, { viewer: false })).status, 401);
  assert.equal((await f.request('snapshot', { viewer: true, headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const caps = await f.request('capabilities', options);
  assert.equal(caps.data.grantCreation, false);
  assert.equal(caps.data.checkpointCreation, false);
  const stream = await f.stream('events', grant.headers, false), first = await stream.next();
  const reconnect = await f.stream('events', { ...grant.headers, 'Last-Event-ID': first.id }, false);
  assert.equal((await reconnect.next()).data.reason, 'history_not_granted');
});

test('grants are project and principal bound, finite, and expire across API restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('grants', { projectId: 'wrong-project', fields, history: true })).status, 403);
  for (const input of [{ fields: ['raw'] }, { fields: [] }, { fields: ['entities', 'entities'] },
    { history: 'yes' }, { ttlSeconds: 0 }, { ttlSeconds: 3601 }, { ttlSeconds: 2.5 }]) {
    assert.equal((await f.post('grants', { projectId, fields, history: false, ...input })).status, 400);
  }
  const grant = await f.grant();
  const other = await fixture(t);
  assert.equal((await other.request('snapshot', { viewer: false, headers: grant.headers })).status, 401);
  for (let i = 1; i < 32; i++) await f.grant();
  assert.equal((await f.post('grants', { projectId, fields, history: false })).status, 429);
});

test('browser grants require exact nonopaque origins and narrowly scoped CORS preflights', async t => {
  const f = await fixture(t);
  for (const bad of ['null', '*', 'https://*.example', 'https://browser.example/', 'https://browser.example/path',
    'https://user:pass@browser.example', 'file://', 'https://browser.example#fragment']) {
    assert.equal((await f.post('grants', { projectId, fields, history: true, origins: [bad] })).status, 400, bad);
  }
  const origin = 'https://browser.example', grant = await f.grant({ origins: [origin] });
  const good = await f.request('snapshot', { viewer: false, headers: { ...grant.headers, Origin: origin } });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), origin);
  assert.equal(good.headers.get('access-control-allow-credentials'), null);
  for (const bad of ['null', 'https://other.example', 'https://browser.example.evil']) {
    assert.equal((await f.request('snapshot', { viewer: false, headers: { ...grant.headers, Origin: bad } })).status, 403);
  }
  const preflight = await f.request('events', { viewer: false, method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization, Last-Event-ID' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.request('events?scope=root&session=session-one', { viewer: false, method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization' } })).status, 204);
  const denied = await f.request('events', { viewer: false, method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'POST' } });
  assert.equal(denied.status, 403);
  const unrelated = await f.grant();
  assert.equal((await f.request('snapshot', { viewer: false,
    headers: { ...unrelated.headers, Origin: origin } })).status, 403);
  await f.post('grants/revoke', { grantId: grant.grant.id });
  assert.equal((await f.request('events', { viewer: false, method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'GET' } })).status, 403);
});

test('revocation immediately closes already-open external streams and denies future reads', async t => {
  const f = await fixture(t), grant = await f.grant();
  const stream = await f.stream('events', grant.headers, false);
  assert.equal((await stream.next()).type, 'snapshot');
  await f.post('grants/revoke', { grantId: grant.grant.id });
  assert.equal((await stream.next()).type, 'revoked');
  await stream.completion;
  assert.equal(stream.ended, true);
  assert.equal((await f.request('snapshot', { viewer: false, headers: grant.headers })).status, 401);
  assert.equal((await f.post('grants/revoke', { grantId: grant.grant.id })).status, 200);
});

test('grant expiry closes idle streams without a notification or new request', async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now }), grant = await f.grant({ ttlSeconds: 60 });
  const stream = await f.stream('events', grant.headers, false);
  await stream.next();
  now += 60_001;
  assert.equal((await stream.next()).type, 'expired');
  await stream.completion;
  assert.equal((await f.request('snapshot', { viewer: false, headers: grant.headers })).status, 401);
});

test('policy tightening updates live streams and reconnect never replays old protected labels', async t => {
  let hide = false;
  const f = await fixture(t, { read: (_selection, current) => {
    const value = structuredClone(current);
    if (hide) for (const record of value.entities) record.label = 'Withheld';
    return value;
  } });
  const grant = await f.grant(), stream = await f.stream('events', grant.headers, false);
  const initial = await stream.next();
  hide = true; f.api.notify();
  assert.ok((await stream.next()).data.entities.every(e => e.label === 'Withheld'));
  const resumed = await f.stream('events', { ...grant.headers, 'Last-Event-ID': initial.id }, false);
  assert.ok((await resumed.next()).data.entities.every(e => e.label === 'Withheld'));
});

test('stream limits, slow output and shutdown remain bounded', async t => {
  const f = await fixture(t);
  const streams = [];
  for (let i = 0; i < 16; i++) { const stream = await f.stream(); await stream.next(); streams.push(stream); }
  assert.equal((await f.request('events')).status, 503);
  streams[0].stop(); await tick(); await delay(20);
  // Inject only the response buffer size at the HTTP fixture boundary, without
  // allocating unbounded client buffers or relying on platform socket tuning.
  const sockets = [];
  const connection = socket => sockets.push(socket);
  f.server.on('connection', connection);
  const slow = await f.stream(); await slow.next();
  assert.ok(sockets.length);
  const response = sockets.at(-1)._httpMessage;
  assert.ok(response);
  Object.defineProperty(response, 'writableLength', { configurable: true, get: () => 512 * 1024 });
  f.api.notify();
  await slow.completion;
  f.server.removeListener('connection', connection);
  f.api.close(); f.api.close(); f.api.notify();
  assert.equal((await f.request('snapshot')).status, 503);
  for (const stream of streams.slice(1)) await stream.completion;
});
