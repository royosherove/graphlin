import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelClient, modelQuery, hydrateModel, VIEW_MODEL_LIMITS } from '../../runtime/web/model-client.js';
import { createModelAPI } from '../../runtime/daemon/model-api.mjs';
import { createProjectModel } from '../../runtime/model/project-model.mjs';
import { model, entity } from './model-fixtures.mjs';
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

test('model transport handles full snapshot sequence jumps, duplicates, checkpoints and stale requests', async () => {
  const streams = [], calls = [], accepted = [];
  class Stream {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.closed = true; }
    emit(value) { this.listeners.snapshot({ data: JSON.stringify(value) }); }
  }
  const client = createModelClient({ Stream, request: async path => { calls.push(path); return model(); },
    onSnapshot: (value, streamed) => accepted.push([value.sequence, streamed]) });
  await client.open({ scope: 'api', session: 'session.one' });
  streams[0].emit(model({ sequence: 3 }));
  streams[0].emit(model({ sequence: 3 }));
  streams[0].emit(model({ sequence: 2 }));
  await settle();
  assert.deepEqual(accepted, [[1, false], [3, true]]);
  await client.open({ checkpoint: 'checkpoint.one' });
  assert.equal(streams[0].closed, true);
  assert.equal(streams.length, 1);
  assert.equal(calls[1], '/api/model/v1/snapshot?checkpoint=checkpoint.one');
  client.close();
  streams[0].emit(model({ sequence: 5 }));
  assert.equal(accepted.length, 3);
  assert.equal(modelQuery({ scope: 'a b', arbitrary: 'ignored' }), '?scope=a+b');
});

test('actual model API pages hydrate beyond 200 records at one revision and retain honest scope limits', async () => {
  const source = model({ entities: Array.from({ length: 1000 }, (_, index) => entity(`source.${index}`)),
    relations: [], activity: [], interpretations: [] });
  const api = createModelAPI({ projectId: source.projectId, getSnapshot: () => source });
  const server = http.createServer((req, res) => { void api.handle(req, res, { viewerAuthorized: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const paths = [];
  const request = async path => {
    paths.push(path);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    if (!response.ok) throw Object.assign(new Error('http'), { status: response.status });
    return response.json();
  };
  try {
    const initial = await request('/api/model/v1/snapshot');
    assert.ok(initial.entities.length < 200);
    assert.equal(initial.partial, true);
    const hydrated = await hydrateModel(initial, { request });
    assert.equal(hydrated.entities.length, 1000);
    assert.equal(hydrated.partial, false);
    assert.ok(paths.some(path => path.startsWith('/api/model/v1/entities?cursor=')));
    const bounded = await hydrateModel(initial, { request, limits: { ...VIEW_MODEL_LIMITS, entities: 250 } });
    assert.equal(bounded.entities.length, 250);
    assert.equal(bounded.coverage.client.truncated, true);
    assert.equal(bounded.coverage.client.totals.entities, 1000);
    assert.equal(bounded.coverage.client.retained.entities, 250);
  } finally { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('transport positions advance policy-only snapshots even when model sequence stays unchanged', async () => {
  const accepted = [], streams = [];
  const position = (sequence, epoch = 'a'.repeat(22)) => ({ epoch, sequence, eventId: `${epoch}:${sequence}:${'b'.repeat(24)}` });
  class Stream {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() {}
  }
  const client = createModelClient({ request: async () => model({ transport: position(1) }), Stream,
    onSnapshot: (value, streamed) => accepted.push([value.transport.epoch, value.transport.sequence, streamed]) });
  await client.open();
  streams[0].listeners.snapshot({ data: JSON.stringify(model({ transport: position(2) })) });
  await settle();
  streams[0].listeners.snapshot({ data: JSON.stringify(model({ transport: position(1, 'c'.repeat(22)) })) });
  await settle();
  assert.deepEqual(accepted, [['a'.repeat(22), 1, false], ['a'.repeat(22), 2, true], ['c'.repeat(22), 1, false]]);
  client.close();
});

test('an inconsistent revision-bound page is discarded and restarted from a fresh snapshot', async () => {
  const initial = model({ entities: [entity('old')], relations: [],
    pages: { entities: { total: 2, returned: 1, nextCursor: 'synthetic.cursor' } } });
  const accepted = [], paths = [];
  const client = createModelClient({
    Stream: null, onSnapshot: value => accepted.push(value),
    request: async path => {
      paths.push(path);
      if (path.includes('/entities?')) return { ...model({ revision: 2 }), kind: 'entities',
        items: [entity('mixed')], page: { total: 2, offset: 1, returned: 1, nextCursor: null } };
      return paths.length === 1 ? initial : model({ revision: 2, entities: [entity('fresh')], relations: [] });
    },
  });
  await client.open();
  assert.equal(paths.filter(path => path.includes('/snapshot')).length, 2);
  assert.deepEqual(accepted[0].entities.map(entity => entity.id), ['fresh']);
  client.close();
});

test('unsupported model endpoint leaves the legacy viewer usable', async () => {
  const errors = [];
  const client = createModelClient({ request: async () => { throw Object.assign(new Error(), { status: 404 }); },
    onSnapshot: () => assert.fail(), onError: message => errors.push(message) });
  assert.equal(await client.open(), false);
  assert.deepEqual(errors, []);
  client.close();
});

test('session baseline round-trips through the actual checkpoint and session-filtered snapshot API', async () => {
  const core = createProjectModel({ projectId: 'project.baseline-fixture' });
  const api = createModelAPI({ projectId: 'project.baseline-fixture', getSnapshot: core.snapshot,
    createCheckpoint: core.checkpoint });
  const server = http.createServer((req, res) => { void api.handle(req, res, { viewerAuthorized: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/model/v1/checkpoints`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Task baseline', sessionId: 'session.one' }) });
    assert.equal(response.status, 201);
    const { checkpoint } = await response.json();
    assert.equal(checkpoint.sessionId, 'session.one');
    const live = await (await fetch(`${origin}/api/model/v1/snapshot?session=session.one`)).json();
    assert.equal(live.checkpoints[0].id, checkpoint.id);
    const replay = await (await fetch(`${origin}/api/model/v1/snapshot?session=session.one&checkpoint=${checkpoint.id}`)).json();
    assert.equal(replay.checkpoints[0].id, checkpoint.id);
    const other = await (await fetch(`${origin}/api/model/v1/snapshot?session=session.two`)).json();
    assert.equal(other.checkpoints.length, 0);
  } finally { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
