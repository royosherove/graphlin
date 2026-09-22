import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoveryProgressView, createDiscoveryProgress } from '../../runtime/web/discovery-progress.js';
import { normalizeSnapshot, startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, connectionInfo } from './fixtures.mjs';
import { model } from './model-fixtures.mjs';

const coverage = (extra = {}) => ({
  inventoried: 512, complete: true,
  parsing: { parsed: 256, active: 0, queued: 0, deferred: 0, failed: 0, omitted: 0 },
  ...extra,
});
const input = (extra = {}) => ({
  projectId: 'project.synthetic', connection: 'connected', sourceMode: 'source', coverage: coverage(), ...extra,
});
const architecture = (extra = {}) => ({
  status: 'complete', applications: 1, components: 4, attempted: 10, analyzed: 10, pending: 0, ...extra,
});
const text = view => JSON.stringify(view);

test('independent stages use authoritative aggregates, distinguish attempts, and never invent a percentage or ETA', () => {
  const view = discoveryProgressView(input({
    coverage: { counts: { inventoried: 9000 }, complete: false,
      parsing: { parsed: 256, active: 1, queued: 64 } },
    architecture: architecture({ status: 'running', attempted: 48, analyzed: 1, pending: 319, withheld: 46, unavailable: 1 }),
    entities: Array.from({ length: 2 }, () => ({})),
  }));
  assert.equal(view.active, true);
  assert.deepEqual(view.stages.map(value => value.state), ['limited', 'active', 'active']);
  assert.match(view.stages[0].detail, /9,000 paths found.*total unknown/);
  assert.match(view.stages[1].detail, /256 processed.*1 active.*64 queued/);
  assert.doesNotMatch(view.stages[1].detail, /parsed/);
  assert.match(view.stages[2].detail, /48 attempted.*1 analyzed.*319 pending.*46 withheld.*1 unavailable/);
  assert.doesNotMatch(text(view), /%|percent|ETA|seconds remaining/);
  assert.match(view.note, /Time remaining is not yet measurable/);
  assert.match(view.note, /Remove hardcoded secrets and fallback values/);
  assert.match(view.summary, /64 queued for processing.*319 pending architecture checks.*46 withheld/);
});

test('incomplete inventory and terminal omissions do not imply active scanning or completion', () => {
  const view = discoveryProgressView(input({
    coverage: coverage({ complete: false, parsing: { parsed: 256, active: 0, queued: 0, deferred: 18 } }),
    architecture: architecture({ status: 'partial', reason: 'source_withheld', withheld: 46 }),
  }));
  assert.equal(view.active, false);
  assert.equal(view.settled, false);
  assert.match(view.title, /discovery incomplete/);
  assert.match(view.note, /withheld/);
  assert.match(view.stages[1].detail, /18 deferred/);
  assert.equal(view.stages.some(stage => stage.state === 'active'), false);
});

test('only explicit inventory scanning activates Find files, including before model hydration', () => {
  for (const c of [null, coverage({ complete: false })]) {
    const view = discoveryProgressView(input({ coverage: c,
      discovery: { inventory: { status: 'scanning', startedAt: 100, finishedAt: null } } }));
    assert.equal(view.active, true);
    assert.equal(view.stages[0].state, 'active');
    assert.match(view.stages[0].detail, /Finding paths; total still unknown/);
  }
  const partial = discoveryProgressView(input({ architecture: architecture(),
    discovery: { inventory: { status: 'partial', startedAt: 100, finishedAt: 200 } } }));
  assert.equal(partial.active, false);
  assert.equal(partial.settled, false, 'explicit terminal omissions outweigh older complete coverage');
  const normalized = normalizeSnapshot(snapshot({ discovery: { inventory: {
    status: 'scanning', startedAt: 100, finishedAt: -1, privateText: 'excluded',
  }, raw: 'excluded' } }));
  assert.deepEqual(normalized.discovery, { inventory: { status: 'scanning', startedAt: 100, finishedAt: null } });
  assert.equal(normalizeSnapshot(snapshot({ discovery: { inventory: { status: 'guess' } } })).discovery, null);
});

test('local and metadata modes settle only their applicable work; demo and replay show no live counts', () => {
  const local = discoveryProgressView(input({ sourceMode: 'local' }));
  assert.equal(local.settled, true);
  assert.equal(local.stages[2].state, 'optional');
  assert.match(local.note, /this machine/);
  const metadata = discoveryProgressView(input({ sourceMode: 'metadata',
    coverage: coverage({ parsing: { active: 1, queued: 9, failed: 8 } }) }));
  assert.equal(metadata.active, false);
  assert.equal(metadata.settled, true);
  assert.match(metadata.stages[1].detail, /Off in metadata mode/);
  for (const [mode, title] of [['demo', 'Example map'], ['replay', 'Recorded discovery']]) {
    const view = discoveryProgressView(input({ mode, architecture: architecture({ status: 'running', pending: 99 }) }));
    assert.equal(view.title, title);
    assert.equal(view.active, false);
    assert.equal(view.tracking, false);
    assert.deepEqual(view.stages, []);
  }
  assert.equal(discoveryProgressView(input({ external: true })).visible, false);
});

test('initial capture explicitly blocks readiness until registration completes, while legacy omission retains its behavior', () => {
  const discovery = { inventory: { status: 'complete', startedAt: 100, finishedAt: 200 }, initialCaptureComplete: false };
  for (const sourceMode of ['local', 'source', 'metadata']) {
    const value = input({ sourceMode, discovery, architecture: architecture(),
      coverage: coverage({ parsing: { parsed: 0, active: 0, queued: 0 } }) });
    const pending = discoveryProgressView(value);
    assert.equal(pending.settled, false, sourceMode);
    assert.doesNotMatch(pending.title, /Map ready/);
    if (sourceMode !== 'metadata') {
      assert.equal(pending.stages[1].state, 'waiting');
      assert.match(pending.stages[1].detail, /Awaiting initial source capture/);
    }
    for (const initialCaptureComplete of [true, undefined]) {
      assert.equal(discoveryProgressView({ ...value, discovery: { ...discovery, initialCaptureComplete } }).settled, true);
    }
  }
  assert.equal(normalizeSnapshot(snapshot({ discovery })).discovery.initialCaptureComplete, false);
  assert.equal(normalizeSnapshot(snapshot({ discovery: { ...discovery, initialCaptureComplete: true } }))
    .discovery.initialCaptureComplete, true);
  for (const invalid of [undefined, 'false', 0, null]) {
    assert.equal(Object.hasOwn(normalizeSnapshot(snapshot({ discovery: { ...discovery, initialCaptureComplete: invalid } }))
      .discovery, 'initialCaptureComplete'), false);
  }
});

test('withheld, missing, failed, unsupported, and unreported analysis cannot claim a ready architecture', () => {
  for (const reason of ['source_withheld', 'source_unavailable', 'unsupported_source', 'missing_key', 'analysis_failed']) {
    const view = discoveryProgressView(input({ architecture: architecture({ status: 'unavailable', reason }) }));
    assert.equal(view.settled, false, reason);
    assert.doesNotMatch(view.title, /ready/i);
    if (reason === 'source_withheld') assert.match(view.note, /Remove hardcoded secrets and fallback values; use environment references/);
  }
  assert.equal(discoveryProgressView(input({ architecture: architecture({ applications: 0, components: 0 }) })).settled, false);
  assert.equal(discoveryProgressView(input()).settled, false);
  assert.equal(discoveryProgressView(input({ architecture: architecture(), scoped: true })).settled, false);
  assert.match(discoveryProgressView(input({ scoped: true })).note, /project-wide completion is not established/);
});

test('local capture withholding keeps the source map incomplete and clears on a reported replacement or deletion', () => {
  const discovery = { inventory: { status: 'complete', startedAt: 100, finishedAt: 200 },
    initialCaptureComplete: true, sourceWithheld: 3 };
  const local = input({ sourceMode: 'local', discovery,
    coverage: coverage({ parsing: { parsed: 0, active: 0, queued: 0 } }) });
  for (const sourceMode of ['local', 'source', 'metadata']) {
    const view = discoveryProgressView({ ...local, sourceMode, architecture: architecture({ withheld: 3 }) });
    assert.equal(view.settled, false, sourceMode);
    assert.doesNotMatch(view.title, /Map ready/);
    assert.match(view.stages[1].detail, /3 withheld from source map/);
    if (sourceMode !== 'metadata') assert.equal(view.stages[1].state, 'limited');
    assert.match(view.note, /Remove hardcoded secrets and fallback values; use environment references/);
    assert.match(view.summary, /3 withheld from source map/);
    assert.equal((view.summary.match(/withheld/g) || []).length, 1, 'the compact summary does not add overlapping counts');
    assert.doesNotMatch(view.summary, /6 withheld/);
  }
  const cleared = discoveryProgressView({ ...local, discovery: { ...discovery, sourceWithheld: 0 } });
  assert.equal(cleared.settled, true);
  assert.doesNotMatch(cleared.note, /withheld/);
  assert.doesNotMatch(cleared.stages[1].detail, /withheld/);
  for (const value of [0, 3]) {
    assert.equal(normalizeSnapshot(snapshot({ discovery: { ...discovery, sourceWithheld: value } }))
      .discovery.sourceWithheld, value);
  }
  for (const value of [undefined, '3', -1, Infinity, 1e10]) {
    assert.equal(Object.hasOwn(normalizeSnapshot(snapshot({ discovery: { ...discovery, sourceWithheld: value } }))
      .discovery, 'sourceWithheld'), false);
  }
});

test('legacy inspected counts remain attempts and arbitrary text, arrays, or invalid metrics are never displayed', () => {
  const view = discoveryProgressView(input({
    architecture: { status: 'running', inspected: 12, analyzed: -1, pending: '99',
      reason: '<secret input>', source: 'private code', withheld: Infinity },
  }));
  assert.match(view.stages[2].detail, /12 attempted/);
  assert.doesNotMatch(text(view), /private|secret|99|Infinity|-1|analyzed/);
  for (const value of ['source', 'local', 'metadata']) assert.equal(normalizeSnapshot(snapshot({ sourceMode: value })).sourceMode, value);
  assert.equal(normalizeSnapshot(snapshot()).sourceMode, 'unknown');
  assert.equal(normalizeSnapshot(snapshot({ sourceMode: '<private>' })).sourceMode, 'unknown');
});

async function harness() {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  let time = 0, next = 0;
  const timers = new Map();
  const progress = createDiscoveryProgress({
    document, now: () => time,
    schedule(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    cancel(id) { timers.delete(id); },
  });
  return {
    document, progress, timers, $: id => document.getElementById(id),
    advance(milliseconds) {
      const target = time + milliseconds;
      for (;;) {
        const job = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!job) break;
        timers.delete(job[0]); time = job[1].at; job[1].callback();
      }
      time = target;
    },
    close() { progress.close(); assert.equal(timers.size, 0); },
  };
}

test('startup expands after 500ms, collapses after settling, and background work preserves a manual collapse', async () => {
  const h = await harness();
  try {
    h.progress.update(input()); h.progress.architecture(architecture({ status: 'running', pending: 4 }));
    assert.equal(h.$('discovery-details').hidden, true);
    h.advance(500);
    assert.equal(h.$('discovery-details').hidden, false);
    assert.equal(h.$('discovery-meter').hidden, false);
    assert.equal(h.$('discovery-meter').getAttribute('aria-valuenow'), null);
    h.$('discovery-toggle').focus();
    h.progress.architecture(architecture()); h.advance(5000);
    assert.equal(h.$('discovery-details').hidden, true);
    assert.equal(h.document.activeElement, h.$('discovery-toggle'));
    h.progress.architecture(architecture({ status: 'running', pending: 2 })); h.advance(1000);
    assert.equal(h.$('discovery-details').hidden, true, 'background edits retain the compact summary');
    await h.$('discovery-toggle').fire('click');
    assert.equal(h.$('discovery-details').hidden, false);
    await h.$('discovery-toggle').fire('click');
    h.progress.update(input({ sessionId: 'another-session' }));
    h.advance(2000);
    assert.equal(h.$('discovery-details').hidden, true);
  } finally { h.close(); }
});

test('fast completion stays compact; clock survives snapshots and sessions, freezes on disconnect, and resets for another project', async () => {
  const h = await harness();
  try {
    h.progress.update(input()); h.progress.architecture(architecture()); h.advance(1500);
    assert.equal(h.$('discovery-details').hidden, true);
    const before = h.$('discovery-elapsed').textContent;
    h.progress.update(input({ sessionId: 'session.next' }));
    assert.equal(h.$('discovery-elapsed').textContent, before);
    h.progress.update(input({ connection: 'reconnecting' }));
    const frozen = h.$('discovery-elapsed').textContent;
    h.advance(10000);
    assert.equal(h.$('discovery-elapsed').textContent, frozen);
    h.progress.update(input()); h.advance(1000);
    assert.match(h.$('discovery-elapsed').textContent, /Tracking for 2s/);
    h.progress.update(input({ projectId: 'project.other' }));
    assert.equal(h.$('discovery-elapsed').textContent, 'Tracking for 0s');
    assert.doesNotMatch(h.$('discovery-stage-2-detail').textContent, /10 analyzed/);
  } finally { h.close(); }
});

test('shared-feed null resets, replay, demo, hidden pages, suspension, and close do not leak live progress or clocks', async () => {
  const h = await harness();
  try {
    h.progress.update(input()); h.progress.architecture(architecture({ status: 'running', pending: 444 }));
    h.progress.architecture(null);
    assert.doesNotMatch(h.$('discovery-stage-2-detail').textContent, /444/);
    h.progress.update(input({ replay: true })); h.advance(1000);
    assert.match(h.$('discovery-title').textContent, /Recorded/);
    assert.equal(h.$('discovery-details').hidden, true);
    assert.equal(h.timers.size, 0);
    h.progress.update(input({ mode: 'demo' }));
    assert.equal(h.$('discovery-title').textContent, 'Example map');
    assert.equal(h.timers.size, 0);
    h.progress.update(input());
    h.document.hidden = true; h.document.fire('visibilitychange');
    assert.equal(h.timers.size, 0);
    h.document.hidden = false; h.document.fire('visibilitychange');
    assert.ok(h.timers.size > 0);
    h.progress.suspend(); assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});

test('Blocks accepts distinct legacy/model project IDs and rejects coverage from superseded model loads', async () => {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id), streams = [], calls = [];
  const originals = new Map(['document', 'window', 'fetch', 'EventSource']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let viewer;
  try {
    globalThis.document = document;
    globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: {},
      matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} };
    globalThis.EventSource = class {
      constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
      addEventListener(type, callback) { this.listeners[type] = callback; }
      close() { this.closed = true; }
    };
    const currentModel = model({ coverage: coverage({ inventoried: 9000, complete: false }) });
    let currentSnapshot = snapshot({ projectId: 'legacy-project-one', sourceMode: 'source',
      discovery: { inventory: { status: 'partial', startedAt: 100, finishedAt: 200 } } });
    let modelReply;
    const settle = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    globalThis.fetch = async (path, options) => {
      calls.push({ path, method: options?.method || 'GET' });
      let value;
      if (path === '/api/state') value = currentSnapshot;
      else if (path === '/api/connection-info') value = connectionInfo();
      else if (path === '/api/extensions') value = { extensions: [] };
      else if (path.startsWith('/api/model/v1/snapshot')) value = modelReply ? await modelReply : currentModel;
      else if (path === '/api/architecture') value = architecture({ status: 'partial', reason: 'source_withheld',
        attempted: 40, analyzed: 4, withheld: 36 });
      else return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(value));
    };
    viewer = startViewer();
    await viewer.ready;
    await settle();
    const live = streams.find(value => value.path === '/api/events');
    live.listeners.open();
    assert.equal($('visualizer').value, 'graphlin.blocks');
    assert.match($('discovery-note').textContent, /Remove hardcoded secrets and fallback values; use environment references/);
    assert.match($('discovery-stage-0-detail').textContent, /9,000 paths found/);
    assert.match($('discovery-stage-2-detail').textContent, /40 attempted.*4 analyzed.*36 withheld/);
    assert.match($('discovery-title').textContent, /discovery incomplete/);
    assert.equal($('discovery-meter').hidden, true);
    assert.equal(calls.filter(value => value.path === '/api/architecture').length, 1);
    assert.equal(calls.some(value => value.method !== 'GET'), false);

    // The legacy stream changes first. Its IDs have a different scheme from
    // model IDs; freshness comes from the model client's load/reset lifecycle.
    const stale = deferred(), fresh = deferred();
    modelReply = stale.promise;
    currentSnapshot = snapshot({ ...currentSnapshot, projectId: 'legacy-project-two', sessionId: 'session-two' });
    live.listeners.snapshot({ data: JSON.stringify(currentSnapshot) });
    await settle();
    assert.match($('discovery-stage-0-detail').textContent, /Waiting for inventory counts/);
    assert.doesNotMatch($('discovery-stage-1-detail').textContent, /256 processed/);

    modelReply = fresh.promise;
    currentSnapshot = snapshot({ ...currentSnapshot, projectId: 'legacy-project-three', sessionId: 'session-three' });
    live.listeners.snapshot({ data: JSON.stringify(currentSnapshot) });
    await settle();
    stale.resolve(model({ projectId: 'canonical-model-two', coverage: coverage({ inventoried: 12345 }) }));
    await settle();
    assert.match($('discovery-stage-0-detail').textContent, /Waiting for inventory counts/);
    assert.doesNotMatch($('discovery-stage-0-detail').textContent, /12,345/);

    fresh.resolve(model({ projectId: 'canonical-model-three', coverage: coverage({ inventoried: 512 }) }));
    await settle();
    assert.match($('discovery-stage-0-detail').textContent, /512 paths found/);
    assert.match($('discovery-stage-1-detail').textContent, /256 processed/);
  } finally {
    viewer?.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
