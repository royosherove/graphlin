import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  startViewer, normalizeSnapshot, onboardingProgress, friendlyProjectName, ORIENTATION_PROMPT,
} from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, activity, connectionInfo } from './fixtures.mjs';

const empty = (overrides = {}) => snapshot({
  graph: graph(0, { nodes: [], edges: [] }), history: [], activity: [], hookEvents: [],
  status: { classifier: 'ready', calls: 0, pending: 0 }, ...overrides,
});
const progress = (value, connection = 'connected') => onboardingProgress(normalizeSnapshot(value), connection);
const step = (value, id) => value.steps.find(item => item.id === id);

async function harness({ initial = empty(), info = async () => connectionInfo(), clipboard } = {}) {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  const originals = new Map(['document', 'window', 'fetch', 'EventSource'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [], streams = [];
  let current = initial;
  globalThis.document = document;
  globalThis.window = {
    location: { hash: `#token=${'a'.repeat(43)}`, pathname: '/', search: '' },
    history: { replaceState() { globalThis.window.location.hash = ''; } },
    navigator: { clipboard }, addEventListener() {}, removeEventListener() {},
  };
  globalThis.EventSource = class {
    constructor() { this.listeners = new Map(); streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() {}
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (url === '/api/about') return new Response('{}', { status: 404 });
    if (url === '/api/auth') return new Response('{"ok":true}');
    if (url === '/api/connection-info') return new Response(JSON.stringify(await info(options)));
    if (url === '/api/diagnostics') return new Response('{"schemaVersion":1,"records":[]}');
    if (url === '/api/control') {
      current = { ...current, paused: JSON.parse(options.body).action === 'pause' };
      return new Response('{"ok":true}');
    }
    assert.equal(url, '/api/state');
    return new Response(JSON.stringify(current));
  };
  const viewer = startViewer();
  return {
    viewer, document, markup, requests, streams, $: id => document.getElementById(id),
    async ready() { await viewer.ready; streams.at(-1).emit('open'); },
    send(value) { current = value; streams.at(-1).emit('snapshot', JSON.stringify(value)); },
    close() {
      viewer.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('progress never substitutes package presence, activity or ready status for delivery, trust or a classifier call', () => {
  const value = empty({
    installed: true, trusted: true, pluginRoots: ['/fixture/plugin'],
    activity: [activity(1, { kind: 'tool.started' })],
  });
  const before = progress(value);
  assert.equal(step(before, 'server').state, 'observed');
  assert.equal(step(before, 'setup').state, 'unverified');
  for (const id of ['hooks', 'classification', 'shape']) assert.equal(step(before, id).state, 'waiting');
  assert.match(before.next.text, /\/hooks/);

  const received = progress({ ...value, hookEvents: [activity(1, { receipt: 1, state: 'failed' })] });
  assert.equal(step(received, 'hooks').label, 'Hook delivery observed', 'even failed tool activity still reports delivery');
  assert.equal(step(received, 'setup').state, 'unverified');
  assert.equal(step(received, 'classification').state, 'waiting');
  const older = { ...value };
  delete older.hookEvents;
  assert.equal(step(progress(older), 'hooks').state, 'waiting');
  assert.match(progress(older).next.text, /Restart.*hook receipts/);
  assert.equal(step(progress({ ...value, hookEvents: [{ receipt: -1 }] }), 'hooks').state, 'waiting');
});

test('calls and shapes are separate observations; retained history and selected session determine the first shape', () => {
  const calls = empty({ status: { classifier: 'timeout', calls: 1, pending: 0 } });
  assert.equal(step(progress(calls), 'classification').label, 'Classification call observed');
  assert.equal(step(progress(calls), 'shape').state, 'waiting');
  const historical = { ...calls, history: [{ graph: graph(1), at: 1 }] };
  assert.equal(step(progress(historical), 'shape').state, 'observed');
  assert.equal(step(progress(empty({ sessionId: 'session-2' })), 'shape').state, 'waiting');
  const demo = progress(snapshot({ mode: 'demo', hookEvents: [activity(1, { receipt: 1 })] }));
  for (const id of ['hooks', 'classification', 'shape']) assert.equal(step(demo, id).state, 'demo');
  assert.equal(step(demo, 'setup').state, 'unverified');
  assert.match(demo.next.text, /offline demo/);
});

test('the next action addresses real server, key, consent, pause, failure and queue states', () => {
  for (const [classifier, match, action] of [
    ['missing_key', /init.*TypeSafe API key.*masked prompt/, 'connect'],
    ['metadata_only', /graphlin init.*source mode if you consent.*TypeSafe/, 'connect'],
    ['paused', /Resume classification/, 'resume'],
    ['unavailable', /reported failure/, 'diagnostics'],
    ['timeout', /reported failure/, 'diagnostics'],
  ]) {
    const next = progress(empty({ status: { classifier } })).next;
    assert.match(next.text, match);
    assert.equal(next.action, action);
    if (['missing_key', 'metadata_only'].includes(classifier)) assert.match(next.text, /stop and restart/);
  }
  const received = empty({ hookEvents: [activity(1, { receipt: 1 })], status: { classifier: 'ready', pending: 2 } });
  assert.match(progress(received).next.text, /queued/);
  for (const state of ['auth', 'reconnecting', 'error']) {
    const next = progress(received, state).next;
    assert.equal(next.action, 'reconnect');
    assert.match(next.text, state === 'auth' ? /fresh viewer link/ : /server is running/);
    assert.equal(step(progress(received, state), 'server').state, 'waiting');
  }
});

test('startup authenticates before loading the friendly project name and preserves the opaque ID as a tooltip', async () => {
  const h = await harness({ info: async () => connectionInfo({
    projectRoot: '/fixture/private-parent/Notes <img src=x> project/',
    key: 'fixture-secret-never-display', launchToken: 'fixture-token-never-display',
  }) });
  try {
    await h.ready();
    assert.deepEqual(h.requests.map(item => item.url), ['/api/auth', '/api/state', '/api/connection-info', '/api/about']);
    const request = h.requests.at(-1);
    assert.equal(request.method, 'GET');
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.body, undefined);
    assert.equal(h.$('project-label').textContent, 'Notes <img src=x> project');
    assert.equal(h.$('project-label').title, 'project-1');
    assert.equal(h.$('project-label').querySelector('img'), null);
    assert.equal(h.$('project-path').textContent, '/fixture/private-parent/Notes <img src=x> project/');
    assert.doesNotMatch(h.document.body.textContent, /fixture-secret-never-display|fixture-token-never-display/);
    assert.equal(h.$('onboarding-server').textContent, 'Server connected');
    assert.equal(h.$('onboarding-setup').dataset.state, 'unverified');
    assert.equal(h.$('classifier-label').textContent, 'Classifier ready');
    assert.match(h.markup, /class="onboarding"[^>]*aria-labelledby="onboarding-title"/);
    assert.equal(friendlyProjectName('/'), 'Local project');
  } finally { h.close(); }
});

test('an older connection endpoint keeps the viewer working; opening instructions can recover the name', async () => {
  let unavailable = true;
  const h = await harness({ info: async () => {
    if (unavailable) throw new Error('fixture-private-error');
    return connectionInfo();
  } });
  try {
    await h.ready();
    assert.equal(h.$('project-label').textContent, 'Project project-1');
    assert.equal(h.$('onboarding-server').textContent, 'Server connected');
    assert.doesNotMatch(h.document.body.textContent, /fixture-private-error/);
    unavailable = false;
    h.$('onboarding-action').focus();
    await h.$('onboarding-action').fire('click');
    assert.equal(h.$('connection-dialog').open, true);
    assert.equal(h.$('project-label').textContent, 'Notes project');
    await h.$('connection-dialog-close').fire('click');
    assert.equal(h.document.activeElement, h.$('onboarding-action'));
  } finally { h.close(); }
});

test('orientation copies only the fixed prompt, handles denied clipboard, and stays hidden in replay and demo', async () => {
  const copied = [];
  let denied = false;
  const h = await harness({ clipboard: { async writeText(value) {
    if (denied) throw new Error('denied');
    copied.push(value);
  } } });
  try {
    await h.ready();
    assert.equal(h.$('orientation').hidden, false);
    await h.$('orientation-copy').fire('click');
    assert.deepEqual(copied, [ORIENTATION_PROMPT]);
    assert.match(h.$('orientation-copy-status').textContent, /Copied/);
    denied = true;
    await h.$('orientation-copy').fire('click');
    assert.equal(h.document.activeElement, h.$('orientation-prompt'));
    assert.match(h.$('orientation-copy-status').textContent, /copy it manually/);
    h.send(empty({ history: [{ revision: 0, at: 1, graph: graph(0, { nodes: [], edges: [] }) }] }));
    await h.$('replay').fire('click');
    assert.equal(h.$('orientation').hidden, true);
    await h.$('live').fire('click');
    assert.equal(h.$('orientation').hidden, false);
    h.send(empty({ mode: 'demo' }));
    assert.equal(h.$('orientation').hidden, true);
  } finally { h.close(); }
});

test('activity can be hidden without stopping capture; troubleshooting opens the existing filtered log and restores focus', async () => {
  const h = await harness({ initial: empty({ hookEvents: [activity(1, { receipt: 1 })] }) });
  try {
    await h.ready();
    await h.$('activity-toggle').fire('click');
    assert.equal(h.$('activity-content').hidden, true);
    assert.equal(h.$('activity-toggle').getAttribute('aria-expanded'), 'false');
    h.send(empty({ activity: [activity()], hookEvents: [activity(1, { receipt: 1 })] }));
    assert.equal(h.$('activity-content').hidden, true);
    assert.equal(h.$('activity-list').children.length, 1);
    await h.$('activity-toggle').fire('click');
    assert.equal(h.$('activity-content').hidden, false);
    assert.equal(h.$('activity-toggle').getAttribute('aria-expanded'), 'true');
    h.$('onboarding-action').focus();
    await h.$('onboarding-action').fire('click');
    assert.equal(h.$('diagnostics-dialog').open, true);
    await h.$('diagnostics-close').fire('click');
    assert.equal(h.document.activeElement, h.$('onboarding-action'));
    h.streams[0].emit('error');
    assert.match(h.$('onboarding-next').textContent, /server is running/);
    assert.equal(h.$('onboarding-action').dataset.action, 'reconnect');
    assert.equal(h.requests.filter(item => item.method === 'POST').length, 1, 'view and copy controls never change server settings');
  } finally { h.close(); }
});

test('closing aborts optional metadata and prevents its late result from changing the name', async () => {
  let resolve, options;
  const started = new Promise(done => {
    resolve = { started: done };
  });
  const h = await harness({ info: incoming => {
    options = incoming; resolve.started();
    return new Promise(done => { resolve.info = done; });
  } });
  try {
    await started;
    assert.equal(options.signal.aborted, false);
    h.viewer.close();
    assert.equal(options.signal.aborted, true);
    resolve.info(connectionInfo({ projectRoot: '/fixture/late-name' }));
    await h.viewer.ready;
    assert.equal(h.$('project-label').textContent, 'Project project-1');
  } finally { h.close(); }
});

test('resume next action sends the existing control and becomes usable again after confirmation', async () => {
  const h = await harness({ initial: empty({ paused: true }) });
  try {
    await h.ready();
    assert.equal(h.$('onboarding-action').dataset.action, 'resume');
    await h.$('onboarding-action').fire('click');
    const controls = h.requests.filter(item => item.url === '/api/control');
    assert.deepEqual(controls.map(item => JSON.parse(item.body)), [{ action: 'resume' }]);
    assert.equal(h.$('onboarding-action').disabled, false);
    assert.equal(h.$('onboarding-action').dataset.action, 'connect');
  } finally { h.close(); }
});
