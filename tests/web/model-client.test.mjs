import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelClient, modelQuery, hydrateModel, VIEW_MODEL_LIMITS } from '../../runtime/web/model-client.js';
import { createModelAPI } from '../../runtime/daemon/model-api.mjs';
import { createProjectModel } from '../../runtime/model/project-model.mjs';
import { model, entity } from './model-fixtures.mjs';
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const firstPage = () => model({ entities: [entity('root')], relations: [],
  pages: { entities: { total: 2, returned: 1, nextCursor: 'synthetic.cursor' } } });
const lastPage = () => ({ ...firstPage(), kind: 'entities', items: [entity('child', 'root')],
  page: { total: 2, offset: 1, returned: 1, nextCursor: null } });
function fakeClock() {
  const originals = { setTimeout, clearTimeout }, timers = new Map();
  let now = 0, id = 0;
  globalThis.setTimeout = (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  return {
    timers,
    tick(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    restore() {
      globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout;
    },
  };
}

test('continuous updates after full hydration publish the latest consistent first page within one second, before a quiet period', async () => {
  const clock = fakeClock(), streams = [], accepted = [], pages = [];
  const snapshot = sequence => ({ ...firstPage(), sequence, revision: sequence, entities: [entity(`root.${sequence}`)] });
  const page = sequence => ({ ...lastPage(), sequence, revision: sequence, items: [entity(`child.${sequence}`, `root.${sequence}`)] });
  class Stream {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() {}
  }
  const client = createModelClient({ Stream, onSnapshot: (value, streamed) => accepted.push({ value, streamed }),
    request: async (path, { signal } = {}) => {
      if (!path.includes('/entities?')) return snapshot(1);
      if (!pages.length) { pages.push(null); return page(1); }
      const held = { ...deferred(), signal }; pages.push(held); return held.promise;
    },
  });
  const emit = sequence => streams[0].listeners.snapshot({ data: JSON.stringify(snapshot(sequence)) });
  try {
    await client.open();
    assert.equal(accepted.at(-1).value.partial, false, 'begin with a fully hydrated view');
    emit(2); await settle();
    for (const sequence of [3, 4, 5]) { clock.tick(250); emit(sequence); await settle(); }
    clock.tick(249); emit(6); await settle();
    assert.equal(accepted.at(-1).value.sequence, 1, 'retain the full view only for the bounded waiting period');
    assert.ok(pages.slice(1, -1).every(page => page.signal.aborted), 'each new event interrupted hydration');
    clock.tick(1); await settle();
    const latest = accepted.at(-1).value;
    assert.equal(latest.sequence, 6, 'the latest first page must appear without waiting for hydration or a quiet stream');
    assert.equal(latest.revision, 6);
    assert.deepEqual(latest.entities.map(entity => entity.id), ['root.6'], 'never merge records across revisions');
    assert.equal(latest.partial, true);
    assert.equal(latest.coverage.client.totals.entities, 2);
    assert.equal(latest.coverage.client.retained.entities, 1);
    emit(7); await settle();
    assert.equal(accepted.at(-1).value.sequence, 7, 'a busy stream continues to advance the preview');
    pages.at(-1).resolve(page(7)); await settle();
    assert.equal(accepted.at(-1).value.partial, false);
    assert.equal(accepted.at(-1).streamed, false, 'hydrating the published preview is not new activity');
    pages.slice(1, -1).forEach((held, index) => held.resolve(page(index + 2))); await settle();
    assert.equal(accepted.at(-1).value.sequence, 7, 'cancelled pages cannot overwrite the latest view');
    assert.equal(clock.timers.size, 0, 'finishing hydration clears the preview deadline');
  } finally {
    client.close(); pages.filter(Boolean).forEach(held => held.resolve(page(1))); await settle(); clock.restore();
  }
});

test('delayed first-page delivery is cancelled on scope, replay, suspension, close, and transport epoch changes', async () => {
  const clock = fakeClock();
  try {
    for (const transition of ['scope', 'checkpoint', 'suspend', 'close', 'epoch']) {
      const held = deferred(), streams = [], accepted = [];
      const transport = (epoch, sequence) => ({ epoch, sequence, eventId: `${epoch}:${sequence}` });
      const initial = model({ transport: transport('epoch.one', 1) });
      class Stream {
        constructor() { this.listeners = {}; streams.push(this); }
        addEventListener(type, listener) { this.listeners[type] = listener; }
        close() {}
      }
      const client = createModelClient({ Stream, onSnapshot: value => accepted.push(value),
        request: async path => path.includes('/entities?') ? held.promise : initial,
      });
      const emit = value => streams[0].listeners.snapshot({ data: JSON.stringify(value) });
      try {
        await client.open();
        emit({ ...firstPage(), sequence: 2, transport: transport('epoch.one', 2) }); await settle();
        assert.equal(clock.timers.size, 1, `${transition}: a preview deadline is pending`);
        if (transition === 'scope' || transition === 'checkpoint') await client.open({ [transition]: 'next' });
        else if (transition === 'epoch') emit({ ...firstPage(), transport: transport('epoch.two', 1) });
        else client[transition]();
        await settle();
        const before = accepted.length;
        assert.equal(clock.timers.size, 0, `${transition}: stale preview deadline is cleared`);
        clock.tick(1000); await settle();
        assert.equal(accepted.length, before, `${transition}: stale preview cannot be delivered`);
      } finally { client.close(); held.resolve(lastPage()); await settle(); }
    }
  } finally { clock.restore(); }
});

test('a consistent partial first page is visible while hydration waits, without arrival animation on completion', async () => {
  const page = deferred(), accepted = [];
  const client = createModelClient({ Stream: null,
    request: async path => path.includes('/entities?') ? page.promise : firstPage(),
    onSnapshot: (value, streamed) => accepted.push({ value, streamed }),
  });
  const opening = client.open();
  try {
    await settle();
    assert.equal(accepted.length, 1, 'the first page must not wait for more records');
    assert.deepEqual(accepted[0].value.entities.map(value => value.id), ['root']);
    assert.deepEqual(accepted[0].value.coverage.client.retained.entities, 1);
    assert.equal(accepted[0].value.partial, true);
    page.resolve(lastPage());
    assert.equal(await opening, true);
    assert.deepEqual(accepted.map(({ value, streamed }) => [value.entities.length, value.partial, streamed]),
      [[1, true, false], [2, false, false]]);
  } finally { client.close(); page.resolve(lastPage()); await opening; }
});

test('the live stream starts during hydration and a newer snapshot prevents a late page from replacing it', async () => {
  const page = deferred(), accepted = [], streams = [];
  class Stream {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() {}
  }
  const client = createModelClient({ Stream,
    request: async path => path.includes('/entities?') ? page.promise : firstPage(),
    onSnapshot: value => accepted.push(value),
  });
  const opening = client.open();
  try {
    await settle();
    assert.equal(streams.length, 1, 'live updates must not wait for the page backlog');
    streams[0].listeners.snapshot({ data: JSON.stringify(model({ revision: 2, sequence: 2,
      entities: [entity('new')], relations: [] })) });
    await settle();
    assert.deepEqual(accepted.at(-1).entities.map(value => value.id), ['new']);
    page.resolve(lastPage()); await opening; await settle();
    assert.deepEqual(accepted.map(value => value.entities.map(entity => entity.id)), [['root'], ['new']]);
  } finally { client.close(); page.resolve(lastPage()); await opening; }
});

test('successive streamed first pages stay current during initial hydration without repeatedly shrinking a hydrated view', async () => {
  const pages = [deferred(), deferred(), deferred()], accepted = [], streams = [];
  let pageIndex = 0;
  class Stream {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() {}
  }
  const client = createModelClient({ Stream,
    request: async path => path.includes('/entities?') ? pages[pageIndex++].promise : firstPage(),
    onSnapshot: (value, streamed) => accepted.push([value.sequence, value.entities.length, streamed]),
  });
  const opening = client.open();
  const emit = sequence => streams[0].listeners.snapshot({
    data: JSON.stringify({ ...firstPage(), sequence }),
  });
  try {
    await settle();
    emit(2); await settle();
    assert.deepEqual(accepted, [[1, 1, false], [2, 1, true]], 'new first pages replace an unfinished preview');
    pages[1].resolve({ ...lastPage(), sequence: 2 }); await settle();
    assert.deepEqual(accepted.at(-1), [2, 2, false]);
    emit(3); await settle();
    assert.deepEqual(accepted.at(-1), [2, 2, false], 'keep a hydrated view while the next live snapshot fills in');
    pages[2].resolve({ ...lastPage(), sequence: 3 }); await settle();
    assert.deepEqual(accepted.at(-1), [3, 2, true]);
    pages[0].resolve(lastPage()); await opening;
    assert.deepEqual(accepted.at(-1), [3, 2, true]);
  } finally { client.close(); pages.forEach(page => page.resolve(lastPage())); await opening; }
});

test('a new scope aborts background hydration and failed hydration keeps the consistent partial view', async () => {
  const page = deferred(), accepted = [], errors = [];
  let pageSignal;
  const client = createModelClient({ Stream: null, onSnapshot: value => accepted.push(value), onError: value => errors.push(value),
    request: async (path, { signal } = {}) => {
      if (path.includes('/entities?')) { pageSignal = signal; return page.promise; }
      if (path.includes('scope=next')) return model({ entities: [entity('next')], relations: [] });
      return firstPage();
    },
  });
  const opening = client.open();
  try {
    await settle();
    assert.equal(accepted.length, 1);
    await client.open({ scope: 'next' });
    assert.equal(pageSignal.aborted, true);
    page.reject(new Error('late page failure')); await opening;
    assert.deepEqual(accepted.at(-1).entities.map(value => value.id), ['next']);
    assert.deepEqual(errors, [], 'a cancelled request must not replace the new scope status');
  } finally { client.close(); page.resolve(lastPage()); await opening; }

  const partial = [], failures = [];
  const failed = createModelClient({ Stream: null, onSnapshot: value => partial.push(value), onError: value => failures.push(value),
    request: async path => {
      if (path.includes('/entities?')) throw new Error('page unavailable');
      return firstPage();
    },
  });
  try {
    assert.equal(await failed.open(), true);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].partial, true);
    assert.match(failures[0], /partial view is retained/i);
  } finally { failed.close(); }
});

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
  assert.deepEqual(accepted.map(value => value.entities.map(entity => entity.id)), [['old'], ['fresh']]);
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
