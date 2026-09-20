import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewPlatform } from '../../runtime/web/platform.js';
import { createDocument } from './fake-dom.mjs';
import { model } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
async function harness() {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id), calls = [], timers = new Map(), views = [], streams = [];
  const globals = ['EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let timerId = 0, state = { status: 'idle', applications: 0, components: 0, pending: 0, inspected: 0, total: 3 };
  let postResult = { status: 'queued', pending: 3 }, pendingRead;
  const current = model({ checkpoints: [{ id: 'checkpoint.fixture', label: 'Before discovery', revision: 1 }] });
  globalThis.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.EventSource = class {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
  };
  const platform = createViewPlatform({
    document, onView: value => views.push(value), onSelect() {},
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (path.startsWith('/api/model/v1/snapshot')) return current;
      if (path === '/api/extensions') return { extensions: [] };
      if (path === '/api/architecture') return pendingRead ? pendingRead.promise : structuredClone(state);
      if (path === '/api/architecture/discover') return structuredClone(postResult);
      assert.fail(`Unexpected route ${path}`);
    },
  });
  await platform.start(); await settle();
  return {
    $, calls, views, timers, platform,
    setStatus(value) { state = value; },
    setPostResult(value) { postResult = value; },
    holdRead() {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pendingRead = { promise, resolve };
      return value => { pendingRead = null; resolve(value); };
    },
    async choose(id) { $('visualizer').value = id; await $('visualizer').fire('change'); await settle(); },
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.delay === 2000);
      assert.ok(entry, 'a single bounded discovery poll is scheduled');
      timers.delete(entry[0]); await entry[1].callback(); await settle();
    },
    async replay(value) { $('model-position').value = value; await $('model-position').fire('change'); await settle(); },
    close() {
      platform.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    },
  };
}

test('C4 discovery reads host status and only an explicit button click posts an empty request', async () => {
  const h = await harness();
  try {
    assert.equal(h.calls.some(call => call.path.startsWith('/api/architecture')), false);
    await h.choose('graphlin.c4');
    assert.equal(h.$('architecture-discover').hidden, false);
    assert.equal(h.$('architecture-discover').disabled, false);
    assert.match(h.$('architecture-status').textContent, /Ready to discover/);
    assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, 1);
    h.$('c4-level').value = 'components'; await h.$('c4-level').fire('change');
    h.platform.filter('save', null); await settle();
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    await h.$('architecture-discover').fire('click'); await settle();
    const posts = h.calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts.map(call => [call.path, JSON.parse(call.body)]), [['/api/architecture/discover', {}]]);
    assert.equal(h.calls.some(call => call.path === '/api/extensions/grant'), false);
    assert.equal(h.$('architecture-discover').disabled, true);
    assert.match(h.$('architecture-status').textContent, /queued.*3 pending/);
    h.setStatus({ status: 'running', inspected: 1, total: 3, pending: 2 });
    await h.poll();
    assert.match(h.$('architecture-status').textContent, /Discovering architecture.*1 of 3 inspected.*2 pending/);
    h.setStatus({ status: 'complete', applications: 1, components: 2, inspected: 3, total: 3 });
    await h.poll();
    assert.equal(h.$('architecture-discover').disabled, false);
    assert.match(h.$('architecture-status').textContent, /complete.*1 applications.*2 components/);
  } finally { h.close(); }
});

test('discovery feedback explains consent, missing keys, missing source, and immediate unavailable responses', async () => {
  const h = await harness();
  try {
    h.setStatus({ status: 'unavailable', reason: 'source_consent_required' });
    await h.choose('graphlin.c4');
    assert.match(h.$('architecture-status').textContent, /source-transmission consent/);
    assert.equal(h.$('architecture-discover').disabled, true);
    await h.$('architecture-discover').fire('click');
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    for (const [reason, text] of [['missing_key', /service key/], ['no_source', /No source evidence/],
      ['paused', /Resume classification/], ['unsupported_service', /does not support/]]) {
      h.setStatus({ status: 'unavailable', reason }); await h.poll();
      assert.match(h.$('architecture-status').textContent, text);
      assert.equal(h.$('architecture-discover').disabled, true);
    }
    h.setStatus({ status: 'idle' }); await h.poll();
    h.setPostResult({ status: 'unavailable', reason: 'analysis_failed' });
    await h.$('architecture-discover').fire('click'); await settle();
    assert.match(h.$('architecture-status').textContent, /could not finish/);
    assert.equal(h.$('architecture-discover').disabled, false);
    h.setStatus({ status: 'unavailable', reason: '<untrusted source text>' }); await h.poll();
    assert.match(h.$('architecture-status').textContent, /Check project source settings/);
    assert.doesNotMatch(h.$('architecture-status').textContent, /untrusted/);
  } finally { h.close(); }
});

test('replay and leaving C4 abort status reads, cancel polling, and ignore late replies', async () => {
  const h = await harness();
  try {
    const finish = h.holdRead();
    await h.choose('graphlin.c4');
    const read = h.calls.find(call => call.path === '/api/architecture');
    await h.replay('checkpoint.fixture');
    assert.equal(read.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.$('architecture-discover').disabled, true);
    assert.match(h.$('architecture-status').textContent, /Recorded architecture/);
    await h.$('architecture-discover').fire('click'); await settle();
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    finish({ status: 'complete', applications: 99 }); await settle();
    assert.doesNotMatch(h.$('architecture-status').textContent, /99/);
    await h.replay('');
    assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, 2);
    await h.choose('graphlin.code');
    assert.equal(h.$('architecture-status').hidden, true);
    assert.equal(h.$('architecture-discover').hidden, true);
    assert.equal(h.timers.size, 0);
    await h.choose('graphlin.c4');
    h.platform.suspend();
    assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});
