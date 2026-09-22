import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewPlatform } from '../../runtime/web/platform.js';
import { createDocument } from './fake-dom.mjs';
import { model, ref } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
async function harness({ onArchitecture, architectureEnabled, hidden = false } = {}) {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  document.hidden = hidden;
  const $ = id => document.getElementById(id), calls = [], timers = new Map(), views = [], streams = [];
  const globals = ['EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let timerId = 0, state = { status: 'idle', applications: 0, components: 0, pending: 0, inspected: 0, total: 3 };
  let postResult = { status: 'queued', pending: 3 }, pendingRead, readError;
  let current = model({ checkpoints: [{ id: 'checkpoint.fixture', label: 'Before discovery', revision: 1 }] });
  globalThis.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.EventSource = class {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
  };
  const platform = createViewPlatform({
    document, onView: value => views.push(value), onSelect() {}, onArchitecture, architectureEnabled,
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (path.startsWith('/api/model/v1/snapshot')) return current;
      if (path === '/api/extensions') return { extensions: [] };
      if (path === '/api/architecture') {
        if (readError) throw readError;
        if (pendingRead) { const read = pendingRead; pendingRead = null; return read.promise; }
        return structuredClone(state);
      }
      if (path === '/api/architecture/discover') return structuredClone(postResult);
      assert.fail(`Unexpected route ${path}`);
    },
  });
  await platform.start(); await settle();
  return {
    $, document, calls, views, timers, platform,
    setStatus(value) { state = value; },
    setPostResult(value) { postResult = value; },
    setReadError(value) { readError = value; },
    async sendModel(value) {
      current = value;
      streams.filter(stream => stream.path.startsWith('/api/model/') && !stream.closed).at(-1)
        .listeners.snapshot({ data: JSON.stringify(value) });
      await settle();
    },
    holdRead() {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pendingRead = { promise, resolve };
      return value => resolve(value);
    },
    async choose(id) { $('visualizer').value = id; await $('visualizer').fire('change'); await settle(); },
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.delay === 2000);
      assert.ok(entry, 'a single bounded discovery poll is scheduled');
      timers.delete(entry[0]); await entry[1].callback(); await settle();
    },
    async replay(value) { $('model-position').value = value; await $('model-position').fire('change'); await settle(); },
    async visibility(hidden) { document.hidden = hidden; document.fire('visibilitychange'); await settle(); },
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
    assert.match(h.$('architecture-status').textContent, /Discovering architecture.*1 of 3 checked.*2 pending/);
    h.setStatus({ status: 'complete', applications: 1, components: 2, inspected: 3, total: 3 });
    await h.poll();
    assert.equal(h.$('architecture-discover').disabled, false);
    assert.match(h.$('architecture-status').textContent, /complete.*1 applications.*2 components/);
  } finally { h.close(); }
});

test('privacy withholding explains safe source changes, separates analyzed from checked, and permits recheck and recovery', async () => {
  const h = await harness();
  const withheld = { status: 'partial', reason: 'source_withheld', applications: 0, components: 0,
    attempted: 5, inspected: 5, analyzed: 0, total: 5, withheld: 5, unsupported: 0, unavailable: 0 };
  try {
    h.setStatus(withheld);
    await h.choose('graphlin.c4');
    const text = h.$('architecture-status').textContent;
    assert.match(text, /withheld.*privacy/i);
    assert.match(text, /Remove hardcoded secrets.*fallbacks.*environment variables/i);
    assert.match(text, /0 analyzed.*5 of 5 checked.*5 withheld/);
    assert.doesNotMatch(text, /inspected|Try again/i);
    assert.equal(h.$('architecture-discover').textContent, 'Recheck sources');
    assert.equal(h.$('architecture-discover').disabled, false);
    h.setPostResult(withheld);
    await h.$('architecture-discover').fire('click'); await settle();
    const posts = h.calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts.map(call => [call.path, JSON.parse(call.body)]), [['/api/architecture/discover', {}]]);
    assert.equal(h.$('architecture-discover').disabled, false, 'an immediate partial response allows another check after editing');
    h.setStatus({ status: 'complete', applications: 1, components: 1, attempted: 5, analyzed: 5,
      inspected: 5, total: 5, withheld: 0, unsupported: 0, unavailable: 0 });
    await h.poll();
    assert.match(h.$('architecture-status').textContent, /complete.*5 analyzed.*5 of 5 checked/);
    assert.doesNotMatch(h.$('architecture-status').textContent, /withheld|privacy/i);
    assert.equal(h.$('architecture-discover').textContent, 'Discover architecture');
    assert.equal(h.$('architecture-discover').disabled, false);
  } finally { h.close(); }
});

test('unsupported and unavailable source remain distinct from failed analysis and checked attempts', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.c4');
    for (const [reason, detail, extra] of [
      ['unsupported_source', /unsupported/i, { unsupported: 3 }],
      ['source_unavailable', /captured or parsed/i, { unavailable: 3 }],
      ['analysis_failed', /could not finish.*Try again/i, { unavailable: 0 }],
    ]) {
      h.setStatus({ status: 'partial', reason, attempted: 3, analyzed: 0, total: 3, ...extra });
      await h.poll();
      assert.match(h.$('architecture-status').textContent, detail);
      assert.match(h.$('architecture-status').textContent, /0 analyzed.*3 of 3 checked/);
      assert.doesNotMatch(h.$('architecture-status').textContent, /inspected/);
      assert.equal(h.$('architecture-discover').disabled, false);
    }
    h.setStatus({ status: 'partial', reason: 'source_withheld', attempted: 5, analyzed: 1,
      total: 5, withheld: 2, unsupported: 1, unavailable: 1 });
    await h.poll();
    assert.match(h.$('architecture-status').textContent, /1 analyzed.*5 of 5 checked.*2 withheld.*1 unsupported.*1 unavailable/);
    h.setStatus({ status: 'partial', reason: 'none_supported', attempted: 5, analyzed: 5, total: 5 });
    await h.poll();
    assert.match(h.$('architecture-status').textContent, /No supported.*5 analyzed.*5 of 5 checked/,
      'validated analysis can honestly find no supported boundaries');
  } finally { h.close(); }
});

test('discovery only renders bounded allowlisted counts and treats legacy inspected as checked', async () => {
  const h = await harness();
  try {
    h.setStatus({ status: 'partial', reason: 'source_withheld', inspected: 5, total: 5 });
    await h.choose('graphlin.c4');
    assert.match(h.$('architecture-status').textContent, /5 of 5 checked/);
    assert.doesNotMatch(h.$('architecture-status').textContent, /inspected|analyzed/);
    h.setStatus({ status: 'partial', reason: 'source_withheld', attempted: 2, inspected: 5,
      analyzed: 1, withheld: 1, unsupported: 0, unavailable: 0, total: 5 });
    await h.poll();
    assert.match(h.$('architecture-status').textContent, /1 analyzed.*2 of 5 checked/);
    assert.doesNotMatch(h.$('architecture-status').textContent, /5 of 5/);
    for (const invalid of [-1, 1.5, 1_000_001, 'PRIVATE_SOURCE_VALUE', { path: 'PRIVATE_SOURCE_VALUE' }]) {
      h.setStatus({ status: 'partial', reason: 'source_withheld', total: 5,
        applications: invalid, components: invalid, pending: invalid, inspected: invalid,
        attempted: invalid, analyzed: invalid, withheld: invalid, unsupported: invalid, unavailable: invalid,
        message: 'PRIVATE_SOURCE_VALUE', files: ['PRIVATE_SOURCE_VALUE'], source: 'PRIVATE_SOURCE_VALUE' });
      await h.poll();
      assert.doesNotMatch(h.$('architecture-status').textContent, /PRIVATE_SOURCE_VALUE|\d|checked|analyzed/,
        'neither invalid counters nor unknown source-bearing fields are displayed');
    }
  } finally { h.close(); }
});

test('privacy status preserves supported boundaries while model updates still invalidate stale interpretations', async () => {
  const h = await harness();
  try {
    const boundary = { id: 'application.fixture', namespace: 'graphlin.architecture', kind: 'application',
      label: 'Fixture application', entityIds: ['api'], sourceRefs: [ref()],
      validity: 'current', classification: 'accepted', support: 'supported' };
    await h.sendModel(model({ revision: 2, sequence: 2, interpretations: [boundary] }));
    await h.choose('graphlin.c4');
    const before = h.views.at(-1);
    assert.ok(before.scene.groups.some(group => group.id === 'c4.application.fixture'));
    h.setStatus({ status: 'partial', reason: 'source_withheld', applications: 1, components: 0,
      attempted: 5, analyzed: 1, withheld: 4, total: 5 });
    await h.poll();
    assert.equal(h.views.at(-1), before, 'a status response neither clears nor rewrites the current scene');
    await h.sendModel(model({ revision: 3, sequence: 3, interpretations: [{ ...boundary, validity: 'stale' }] }));
    assert.equal(h.views.at(-1).scene.groups.some(group => group.id === 'c4.application.fixture'), false,
      'status cannot retain a boundary after its model evidence becomes stale');
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

test('a subscriber shares one status poll across live built-ins while manual discovery stays C4-only', async () => {
  const feed = [], h = await harness({ onArchitecture: value => feed.push(value) });
  const polls = () => [...h.timers.values()].filter(timer => timer.delay === 2000);
  try {
    assert.equal(h.platform.active, 'graphlin.blocks');
    assert.equal(feed.at(-1)?.status, 'idle');
    assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, 1);
    assert.equal(polls().length, 1);
    for (const id of ['graphlin.code', 'graphlin.changes', 'graphlin.timeline', 'graphlin.blocks']) {
      await h.choose(id);
      assert.equal(polls().length, 1, 'switching built-ins never adds a second poll');
      assert.equal(h.$('architecture-discover').hidden, true);
      assert.equal(h.$('architecture-discover').disabled, true);
      await h.$('architecture-discover').fire('click'); await settle();
      assert.equal(h.calls.some(call => call.method === 'POST'), false);
    }
    const reads = h.calls.filter(call => call.path === '/api/architecture').length;
    await h.sendModel(model({ revision: 2, sequence: 2 }));
    await h.sendModel(model({ revision: 3, sequence: 3 }));
    assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, reads,
      'ordinary model deliveries reuse the existing poll');
    await h.choose('graphlin.c4');
    await h.$('architecture-discover').fire('click'); await settle();
    assert.equal(h.calls.filter(call => call.path === '/api/architecture/discover').length, 1);
    assert.equal(feed.at(-1).status, 'queued');
    assert.equal(polls().length, 1);
  } finally { h.close(); }
  assert.equal(feed.at(-1), null, 'disposing the platform clears the subscriber');
});

test('status subscribers receive only sanitized counts and safe errors, without mutating internal status', async () => {
  const feed = [], h = await harness({ onArchitecture: value => feed.push(value) });
  try {
    h.setStatus({ status: 'partial', reason: 'source_withheld', attempted: 5, analyzed: 0, total: 5,
      withheld: 4, unsupported: 1, unavailable: -1, applications: 'PRIVATE_VALUE',
      message: 'PRIVATE_VALUE', source: 'PRIVATE_VALUE', file: 'PRIVATE_VALUE' });
    await h.poll();
    assert.deepEqual(feed.at(-1), { status: 'partial', reason: 'source_withheld', attempted: 5,
      analyzed: 0, total: 5, withheld: 4, unsupported: 1 });
    await h.choose('graphlin.c4');
    feed.at(-1).withheld = 999;
    h.$('c4-level').value = 'components'; await h.$('c4-level').fire('change'); await settle();
    assert.match(h.$('architecture-status').textContent, /4 withheld/);
    assert.doesNotMatch(h.$('architecture-status').textContent, /999/);
    h.setReadError(new Error('PRIVATE_VALUE'));
    await h.poll();
    assert.deepEqual(feed.at(-1), { status: 'unavailable', reason: 'request_failed' });
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 1);
    h.setReadError(Object.assign(new Error('PRIVATE_VALUE'), { status: 404 }));
    await h.poll();
    assert.deepEqual(feed.at(-1), { status: 'unavailable', reason: 'endpoint_unavailable' });
    assert.equal(h.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(feed), /PRIVATE_VALUE/);
  } finally { h.close(); }
});

test('subscribed status resets on replay, project changes and reconnect and ignores aborted replies', async () => {
  const feed = [], h = await harness({ onArchitecture: value => feed.push(value) });
  try {
    const finishReplay = h.holdRead(), replayRead = h.poll();
    await settle();
    const replayRequest = h.calls.filter(call => call.path === '/api/architecture').at(-1);
    await h.replay('checkpoint.fixture');
    assert.equal(replayRequest.signal.aborted, true);
    assert.equal(feed.at(-1), null);
    assert.equal(h.timers.size, 0);
    finishReplay({ status: 'complete', applications: 999 }); await replayRead;
    assert.equal(feed.some(value => value?.applications === 999), false);
    await h.replay('');
    assert.equal(feed.at(-1).status, 'idle');

    const finishProject = h.holdRead(), projectRead = h.poll();
    await settle();
    const projectRequest = h.calls.filter(call => call.path === '/api/architecture').at(-1);
    h.setStatus({ status: 'running', attempted: 1, analyzed: 0, total: 2 });
    const previous = feed.length;
    await h.sendModel(model({ projectId: 'project.next', revision: 2, sequence: 2 }));
    assert.equal(projectRequest.signal.aborted, true);
    assert.equal(feed[previous], null);
    assert.equal(feed.at(-1).status, 'running');
    finishProject({ status: 'complete', applications: 888 }); await projectRead;
    assert.equal(feed.some(value => value?.applications === 888), false);

    const finishReconnect = h.holdRead(), reconnectRead = h.poll();
    await settle();
    const reconnectRequest = h.calls.filter(call => call.path === '/api/architecture').at(-1);
    const opening = h.platform.start();
    assert.equal(reconnectRequest.signal.aborted, true);
    assert.equal(feed.at(-1), null, 'clear previous status before the replacement model arrives');
    await opening; await settle();
    finishReconnect({ status: 'complete', applications: 777 }); await reconnectRead;
    assert.equal(feed.some(value => value?.applications === 777), false);
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 1);
    h.platform.suspend();
    assert.equal(feed.at(-1), null);
    assert.equal(h.timers.size, 0);
    await h.platform.start(); await settle();
    assert.equal(feed.at(-1).status, 'running');
    await h.choose('extension.not-installed');
    assert.equal(feed.at(-1), null, 'third-party views do not keep the built-in feed running');
    assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});

test('the host enablement gate prevents demo polling and rechecks before a scheduled request', async () => {
  let mode = 'demo';
  const feed = [], h = await harness({ onArchitecture: value => feed.push(value),
    architectureEnabled: () => !['demo', 'replay'].includes(mode) });
  try {
    assert.equal(h.platform.active, 'graphlin.blocks');
    assert.equal(h.calls.some(call => call.path === '/api/architecture'), false);
    assert.equal(h.timers.size, 0);
    await h.choose('graphlin.c4');
    assert.equal(h.$('architecture-discover').disabled, true);
    await h.$('architecture-discover').fire('click'); await settle();
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    mode = 'live';
    await h.visibility(false);
    assert.equal(feed.at(-1).status, 'idle');
    const reads = h.calls.filter(call => call.path === '/api/architecture').length;
    mode = 'replay';
    await h.poll();
    assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, reads,
      'a scheduled tick cannot issue one last GET after the gate closes');
    assert.equal(feed.at(-1), null);
    assert.equal(h.timers.size, 0);
    assert.equal(h.$('architecture-discover').disabled, true);
  } finally { h.close(); }
});

test('one visibility listener aborts hidden work and resumes exactly one poll, then is removed on close', async () => {
  const feed = [], h = await harness({ onArchitecture: value => feed.push(value), hidden: true });
  const reads = () => h.calls.filter(call => call.path === '/api/architecture').length;
  try {
    assert.equal(h.document.listeners.get('visibilitychange')?.length, 1);
    assert.equal(reads(), 0, 'a hidden initial page does not poll');
    await h.visibility(false);
    assert.equal(reads(), 1);
    const finish = h.holdRead(), pending = h.poll();
    await settle();
    const request = h.calls.filter(call => call.path === '/api/architecture').at(-1);
    await h.visibility(true);
    assert.equal(request.signal.aborted, true);
    assert.equal(feed.at(-1), null);
    assert.equal(h.timers.size, 0);
    const hiddenReads = reads();
    await h.visibility(true);
    await h.sendModel(model({ revision: 2, sequence: 2 }));
    assert.equal(reads(), hiddenReads);
    assert.equal(h.timers.size, 0);
    finish({ status: 'complete', applications: 999 }); await pending;
    assert.equal(feed.some(value => value?.applications === 999), false);
    await h.visibility(false);
    assert.equal(reads(), hiddenReads + 1);
    await h.visibility(false);
    assert.equal(reads(), hiddenReads + 1, 'repeated visibility events do not duplicate requests');
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 1);
  } finally { h.close(); }
  assert.equal(h.document.listeners.get('visibilitychange')?.length, 0);
  const closedReads = reads();
  await h.visibility(false);
  assert.equal(reads(), closedReads);
});

test('visibility cannot resume a suspended platform, a third-party view, or checkpoint replay', async () => {
  for (const restrict of [h => h.platform.suspend(), h => h.choose('extension.not-installed'),
    h => h.replay('checkpoint.fixture')]) {
    const h = await harness({ onArchitecture() {} });
    try {
      await h.visibility(true);
      await restrict(h);
      const reads = h.calls.filter(call => call.path === '/api/architecture').length;
      await h.visibility(false);
      assert.equal(h.calls.filter(call => call.path === '/api/architecture').length, reads);
      assert.equal(h.timers.size, 0);
    } finally { h.close(); }
  }
});
