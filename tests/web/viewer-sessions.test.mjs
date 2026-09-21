import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, connectionInfo, activity } from './fixtures.mjs';
import { model } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };
const sessions = ['session-1', 'session-2', 'session-3'];
const params = route => new URL(route, 'http://fixture').searchParams;
async function harness({ sessionId = 'session-1' } = {}) {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id), streams = [], calls = [];
  const keys = ['document', 'window', 'fetch', 'EventSource'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  // The legacy and model APIs intentionally use different project identities.
  let legacy = snapshot({ projectId: 'host-project-one', sessionId,
    sessions: sessionId ? sessions.map(id => ({ id, label: id })) : [] });
  let modelProject = 'a'.repeat(64), sequence = 1, hold;
  const modelAt = route => {
    const selected = params(route).get('session');
    const ids = (selected ? [selected] : legacy.sessions.map(value => value.id));
    return model({ projectId: modelProject, revision: sequence, sequence,
      sessions: ids.map(id => ({ id })),
      activity: ids.map((id, index) => ({
        id: `event.${id}`, sessionId: id, sequence: index + 1,
        agentId: `Project ${modelProject[0]} ${id}`, kind: 'tool.requested',
        toolCategory: 'read', outcome: 'pending', attribution: 'observed', entityIds: [],
      })),
      checkpoints: [{ id: 'checkpoint.fixture', label: 'Before new session', revision: 1 }],
    });
  };
  globalThis.document = document;
  globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: {},
    matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} };
  globalThis.EventSource = class {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() { this.closed = true; }
    emit(value) { this.listeners.snapshot?.({ data: JSON.stringify(value) }); }
  };
  globalThis.fetch = async (route, options) => {
    calls.push([route, options]);
    let result;
    if (route === '/api/state') result = legacy;
    else if (route === '/api/connection-info') result = connectionInfo();
    else if (route === '/api/extensions') result = { extensions: [] };
    else if (route.startsWith('/api/model/v1/snapshot')) {
      result = modelAt(route);
      if (hold && params(route).get('session') === hold.sessionId) {
        const pending = hold; hold = null;
        pending.started();
        await pending.wait; // Deliberately ignore abort to exercise late-response guards.
      }
    } else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(result));
  };
  const viewer = startViewer();
  await viewer.ready; await settle();
  const modelReads = () => calls.filter(([route]) => route.startsWith('/api/model/v1/snapshot'));
  const latestModelStream = () => streams.filter(value => value.path.startsWith('/api/model/') && !value.closed).at(-1);
  return {
    $, streams, calls, modelReads, latestModelStream,
    get legacy() { return legacy; },
    set modelProject(value) { modelProject = value; },
    async choose(value) { $('visualizer').value = value; await $('visualizer').fire('change'); await settle(); },
    async selectSession(id) { $('session').value = id; await $('session').fire('change'); await settle(); },
    async sendLegacy(overrides = {}) {
      legacy = { ...legacy, ...overrides }; sequence++;
      streams.filter(value => value.path === '/api/events' && !value.closed).at(-1).emit(legacy);
      await settle();
    },
    holdSession(id) {
      let started, release;
      const seen = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      hold = { sessionId: id, started, wait };
      return { started: seen, release };
    },
    async replay(value) { $('model-position').value = value; await $('model-position').fire('change'); await settle(); },
    async reconnect() { await $('retry').fire('click'); await settle(); },
    close() {
      viewer.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test('a fresh viewer binds its initial model request and stream to the backend-selected session', async () => {
  const h = await harness();
  try {
    assert.equal(h.modelReads().length, 1);
    assert.equal(params(h.modelReads()[0][0]).get('session'), 'session-1');
    assert.equal(params(h.latestModelStream().path).get('session'), 'session-1');
    await h.choose('graphlin.timeline');
    assert.match(h.$('custom-view').textContent, /Project a session-1/);
    assert.doesNotMatch(h.$('custom-view').textContent, /session-2|session-3/);
    await h.sendLegacy();
    assert.equal(h.modelReads().length, 1, 'ordinary receipts do not reopen the model');
  } finally { h.close(); }
});

test('source-only startup follows the first session with Follow agent off and retains parsed architecture', async () => {
  const h = await harness({ sessionId: null });
  try {
    const groups = [...h.$('group-layer').children], oldStream = h.latestModelStream();
    assert.equal(groups.length, 3);
    assert.equal(params(oldStream.path).has('session'), false);
    h.$('follow-agent').checked = false;
    await h.$('follow-agent').fire('change'); await settle();
    await h.sendLegacy({ sessionId: 'session-1', sessions: [{ id: 'session-1', label: 'First session' }] });
    assert.equal(params(h.latestModelStream().path).get('session'), 'session-1');
    assert.equal(h.modelReads().length, 2);
    assert.equal(oldStream.closed, true);
    assert.equal(h.$('session').value, 'session-1');
    assert.equal(h.$('visualizer').value, 'graphlin.blocks');
    assert.deepEqual(h.$('group-layer').children, groups, 'session filtering retains the project source blocks');
  } finally { h.close(); }
});

test('manual session choice survives receipts and compaction until a genuine backend selection change', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.timeline');
    await h.selectSession('session-2');
    const oldStream = h.latestModelStream(), reads = h.modelReads().length;
    await h.sendLegacy({ hookEvents: [activity(20, { kind: 'session.started', sessionId: 'session-2', receipt: 20 })] });
    await h.sendLegacy({ activity: [activity(21, { kind: 'session.compacted', sessionId: 'session-1' })] });
    assert.equal(h.modelReads().length, reads);
    assert.equal(h.$('session').value, 'session-2');
    assert.match(h.$('custom-view').textContent, /Project a session-2/);
    await h.sendLegacy({ sessionId: 'session-3' });
    assert.equal(h.modelReads().length, reads + 1);
    assert.equal(params(h.latestModelStream().path).get('session'), 'session-3');
    assert.equal(h.$('visualizer').value, 'graphlin.timeline');
    assert.equal(h.$('session').value, 'session-3');
    assert.match(h.$('custom-view').textContent, /Project a session-3/);
    oldStream.emit(model({ projectId: 'a'.repeat(64), revision: 999, sequence: 999, activity: [] }));
    await settle();
    assert.match(h.$('custom-view').textContent, /Project a session-3/, 'a late old-session stream cannot replace the new view');
    await h.sendLegacy();
    assert.equal(h.modelReads().length, reads + 1);
  } finally { h.close(); }
});

test('a backend session transition leaves checkpoint replay and reopens Live in the chosen visualizer', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.timeline');
    await h.replay('checkpoint.fixture');
    const reads = h.modelReads().length;
    assert.equal(h.latestModelStream(), undefined);
    await h.sendLegacy();
    assert.equal(h.modelReads().length, reads);
    assert.equal(h.$('model-position').value, 'checkpoint.fixture');
    await h.sendLegacy({ sessionId: 'session-2' });
    assert.equal(h.$('model-position').value, '');
    assert.equal(params(h.modelReads().at(-1)[0]).get('session'), 'session-2');
    assert.equal(params(h.modelReads().at(-1)[0]).has('checkpoint'), false);
    assert.equal(params(h.latestModelStream().path).get('session'), 'session-2');
    assert.equal(h.$('visualizer').value, 'graphlin.timeline');
    assert.match(h.$('custom-view').textContent, /Project a session-2/);
  } finally { h.close(); }
});

test('project changes clear old scope and late requests without confusing host and model project IDs', async () => {
  const h = await harness();
  let pending;
  try {
    await h.choose('graphlin.code');
    const node = h.$('node-layer').children.find(value => value.getAttribute('aria-label').startsWith('run.'));
    await node.fire('click');
    const open = h.$('inspector-body').querySelector('button');
    assert.equal(open.textContent, 'Open source scope');
    await open.fire('click'); await settle();
    assert.equal(params(h.modelReads().at(-1)[0]).get('scope'), 'run');
    await h.choose('graphlin.timeline');
    pending = h.holdSession('session-2');
    await h.sendLegacy({ sessionId: 'session-2' });
    await pending.started;
    h.modelProject = 'b'.repeat(64);
    await h.sendLegacy({ projectId: 'host-project-two' });
    assert.equal(params(h.modelReads().at(-1)[0]).get('session'), 'session-2');
    assert.equal(params(h.modelReads().at(-1)[0]).has('scope'), false);
    assert.match(h.$('custom-view').textContent, /Project b session-2/);
    pending.release(); await settle();
    assert.match(h.$('custom-view').textContent, /Project b session-2/);
    assert.equal(h.$('scope-breadcrumbs').children.length, 1);
    assert.equal(h.$('visualizer').value, 'graphlin.timeline');
    const oldLegacyStream = h.streams.find(value => value.path === '/api/events');
    const reads = h.modelReads().length;
    await h.reconnect();
    assert.equal(h.modelReads().length, reads + 1, 'reconnect opens the selected model once');
    oldLegacyStream.emit(snapshot());
    await settle();
    assert.equal(h.modelReads().length, reads + 1, 'a replaced legacy stream cannot switch sessions');
    assert.match(h.$('custom-view').textContent, /Project b session-2/);
  } finally { pending?.release(); h.close(); }
});
