import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, connectionInfo } from './fixtures.mjs';
import { model, entity } from './model-fixtures.mjs';

const epoch = Date.parse('2026-09-21T12:00:00Z');
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const walk = element => [element, ...element.children.flatMap(walk)];
const input = () => model({
  entities: [entity('project', null, { label: 'Notes', kind: 'project', artifactId: undefined, sourceRefs: [], basis: 'metadata' }),
    entity('src', 'project', { kind: 'directory', artifactId: undefined, sourceRefs: [], basis: 'metadata' }),
    entity('notes.js', 'src', { kind: 'module' }),
    entity('saveNote', 'notes.js', { kind: 'function' })],
  relations: [], checkpoints: [{ id: 'checkpoint.one', revision: 1 }],
});

async function harness() {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id);
  const keys = ['document', 'window', 'fetch', 'EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalNow = Date.now;
  let now = epoch, timerId = 0, current = input(), sequence = 1;
  let dimensions = { width: 900, height: 540 };
  const timers = new Map(), streams = [], requests = [], observers = [], windowListeners = new Map();
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  globalThis.document = document;
  globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: {},
    ResizeObserver, matchMedia: () => ({ matches: true }),
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type) { windowListeners.delete(type); } };
  $('architecture').getBoundingClientRect = () => ({ ...dimensions, x: 0, y: 0 });
  globalThis.setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  Date.now = () => now;
  globalThis.EventSource = class {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() { this.closed = true; }
    emit(value) { this.listeners.snapshot?.({ data: JSON.stringify(value) }); }
  };
  globalThis.fetch = async (path, options) => {
    requests.push([path, options]);
    const value = path === '/api/state' ? snapshot({ status: { classifier: 'missing_key' } })
      : path === '/api/connection-info' ? connectionInfo()
      : path === '/api/extensions' ? { extensions: [] }
      : path.startsWith('/api/model/v1/snapshot') ? current : null;
    return new Response(JSON.stringify(value || {}), { status: value ? 200 : 404 });
  };
  const viewer = startViewer();
  await viewer.ready; await settle();
  return {
    $, requests, timers,
    get now() { return now; },
    get current() { return current; },
    event(kind = 'tool.requested', extra = {}) {
      return { id: `event.${++sequence}`, sequence, kind, at: new Date(now).toISOString(),
        outcome: kind === 'tool.requested' ? 'pending' : kind.slice(5), operation: 'read', mapping: 'exact',
        sessionId: 'session-1', agentId: 'agent.one', toolCallId: 'read.one',
        entityIds: ['notes.js'], artifactIds: ['artifact.one'], sourceRefs: [], ...extra };
    },
    async send(events, overrides = {}) {
      current = { ...current, ...overrides, revision: ++sequence, sequence, activity: events };
      streams.filter(stream => stream.path.startsWith('/api/model/') && !stream.closed).at(-1).emit(current);
      await settle();
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = until; await settle();
    },
    async choose(id) { $('visualizer').value = id; await $('visualizer').fire('change'); await settle(); },
    async expand(label) {
      const toggle = walk($('group-layer')).find(node => node.getAttribute('aria-label') === `Expand ${label}`);
      assert.ok(toggle, `expandable ${label}`);
      await toggle.fire('keydown', { key: 'Enter' }); await settle();
    },
    async replay(id) { $('model-position').value = id; await $('model-position').fire('change'); await settle(); },
    async search(query) { $('diagram-search').value = query; await $('diagram-search').fire('input'); await settle(); },
    resize(width, height, windowResize = false) {
      dimensions = { width, height };
      for (const observer of observers) {
        assert.equal(observer.target, $('diagram-stage'));
        observer.callback();
      }
      if (windowResize) windowListeners.get('resize')?.();
    },
    close() {
      viewer.close(); Date.now = originalNow;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test('clean-load Blocks shows immediate read/edit badges on a collapsed containing block without a key', async () => {
  const h = await harness();
  try {
    assert.equal(h.$('visualizer').value, 'graphlin.blocks');
    h.$('follow-agent').checked = false; await h.$('follow-agent').fire('change'); await settle();
    const read = h.event(), edit = h.event('tool.requested', { operation: 'edit', toolCallId: 'edit.one' });
    await h.send([edit, read]);
    const block = h.$('group-layer').children.find(node => node.getAttribute('aria-label').startsWith('src.'));
    assert.match(block.getAttribute('aria-label'), /Reading.*Editing/);
    assert.equal(block.dataset.reading, 'true'); assert.equal(block.dataset.editing, 'true');
    assert.equal(h.$('current-activity').hidden, false);
    assert.match(h.$('current-activity-items').textContent, /Reading notes.js · in src/);
    assert.match(h.$('current-activity-items').textContent, /Editing notes.js · in src/);
    await h.expand('src');
    const file = h.$('group-layer').children.find(node => node.getAttribute('aria-label').startsWith('notes.js.'));
    assert.match(file.getAttribute('aria-label'), /Reading.*Editing/);
    assert.equal(walk(file).filter(node => node.getAttribute('class') === 'tool-activity-icon').length, 2);
    assert.equal(h.requests.some(([path, options]) => options?.method === 'POST' || path.includes('/analysis')), false);
  } finally { h.close(); }
});

test('terminal and late mapping retain the completion clock; idle timers fade and remove badges without SSE', async () => {
  const h = await harness();
  try {
    const read = h.event();
    await h.send([read]); await h.advance(1000);
    const done = h.event('tool.succeeded');
    await h.send([done, read]);
    assert.match(h.$('current-activity-items').textContent, /Read notes.js/);
    await h.advance(2500);
    await h.send([h.event('activity.mapped', { outcome: 'succeeded', mapping: 'decision', entityIds: ['saveNote'],
      at: done.at, recordedAt: new Date(h.now).toISOString() }), done, read]);
    assert.match(h.$('current-activity-items').textContent, /Read saveNote/);
    const requests = h.requests.length;
    await h.advance(1000);
    assert.equal(h.$('current-activity-items').children[0].dataset.fade, '2');
    assert.ok(walk(h.$('current-activity')).every(node => node.getAttribute('style') === null),
      'fading uses the local stylesheet, without a CSP-blocked inline style');
    await h.advance(500);
    assert.equal(h.$('current-activity').hidden, true);
    assert.equal(walk(h.$('group-layer')).some(node => node.getAttribute('class') === 'tool-activity-badge'), false);
    assert.equal(h.requests.length, requests, 'expiry is local, without polling or model requests');
  } finally { h.close(); }
});

test('flat Code activity badges have finite geometry when layout nodes omit dimensions', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.code');
    await h.send([h.event(), h.event('tool.requested', { operation: 'edit', toolCallId: 'edit.flat' })]);
    const file = h.$('node-layer').children.find(node => node.getAttribute('aria-label').startsWith('notes.js.'));
    assert.match(file.getAttribute('aria-label'), /Reading.*Editing/);
    const badges = walk(file).filter(node => node.getAttribute('class') === 'tool-activity-badge');
    assert.equal(badges.length, 2);
    for (const badge of badges) {
      const width = Number(badge.querySelector('rect').getAttribute('width'));
      assert.ok(Number.isFinite(width) && width > 0, 'badge width is finite and positive');
      assert.doesNotMatch(badge.getAttribute('transform'), /NaN|Infinity/);
      assert.ok(Number.isFinite(Number(badge.querySelector('text').getAttribute('textLength') || 1)));
    }
  } finally { h.close(); }
});

test('authoritative exact completion removes semantic badges and older pages cannot bring them back', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.code');
    const read = h.event();
    const mapped = h.event('activity.mapped', { outcome: 'pending', mapping: 'decision',
      entityIds: ['saveNote', 'notes.js'], at: read.at });
    await h.send([mapped, read]);
    const method = () => h.$('node-layer').children.find(node => node.getAttribute('aria-label').startsWith('saveNote.'));
    assert.match(method().getAttribute('aria-label'), /Reading/);
    await h.advance(1000);
    const done = h.event('tool.succeeded', { mapping: 'exact', entityIds: ['notes.js'] });
    await h.send([done, mapped, read]);
    assert.doesNotMatch(method().getAttribute('aria-label'), /Tool activity/);
    assert.equal(method().dataset.reading, 'false');
    assert.match(h.$('current-activity-items').textContent, /Read notes.js/);
    assert.match(h.$('current-activity-items').children[0].getAttribute('title'), /Exact file target/);
    await h.send([mapped, read]);
    assert.doesNotMatch(method().getAttribute('aria-label'), /Tool activity/);
    await h.advance(2500);
    await h.send([h.event('activity.mapped', { outcome: 'succeeded', mapping: 'decision',
      entityIds: ['saveNote', 'notes.js'], at: done.at }), done]);
    assert.match(method().getAttribute('aria-label'), /Tool activity: Read/);
    assert.doesNotMatch(method().getAttribute('aria-label'), /Reading/);
    assert.match(h.$('current-activity-items').children[0].getAttribute('title'), /Decision-mapped target/);
    await h.advance(1500);
    assert.equal(h.$('current-activity').hidden, true);
  } finally { h.close(); }
});

test('failure is distinct while another call remains active; missing terminal expires locally after a minute', async () => {
  const h = await harness();
  try {
    const read = h.event(), edit = h.event('tool.requested', { toolCallId: 'edit', operation: 'edit' });
    await h.send([edit, read]);
    await h.send([h.event('tool.failed'), edit, read]);
    assert.match(h.$('current-activity-items').textContent, /Read failed notes.js/);
    assert.match(h.$('current-activity-items').textContent, /Editing notes.js/);
    await h.advance(4000);
    assert.doesNotMatch(h.$('current-activity-items').textContent, /Read failed/);
    await h.advance(56000);
    assert.match(h.$('current-activity-items').textContent, /Edit unresolved/);
    assert.doesNotMatch(h.$('current-activity-items').textContent, /Editing/);
    await h.advance(4000);
    assert.equal(h.$('current-activity').hidden, true);
  } finally { h.close(); }
});

test('replay and session changes remove live badges immediately; returning live only shows unexpired calls', async () => {
  const h = await harness();
  try {
    const read = h.event(); await h.send([read]);
    await h.replay('checkpoint.one');
    assert.equal(h.$('current-activity').hidden, true);
    assert.equal(walk(h.$('group-layer')).some(node => node.getAttribute('class') === 'tool-activity-badge'), false);
    await h.advance(65000); await h.replay('');
    assert.equal(h.$('current-activity').hidden, true);
    await h.send([h.event('tool.requested', { toolCallId: 'read.new' })]); assert.equal(h.$('current-activity').hidden, false);
    h.$('session').value = 'session.other'; await h.$('session').fire('change'); await settle();
    assert.equal(h.$('current-activity').hidden, true);
  } finally { h.close(); }
  assert.equal(h.timers.size, 0, 'close cleans the activity timer along with viewer timers');
});

test('Follow centers the represented active block, but search, manual camera and Follow off preserve user focus', async () => {
  const h = await harness();
  try {
    await h.expand('src');
    const before = h.$('architecture').getAttribute('viewBox');
    const read = h.event(); await h.send([read]);
    assert.notEqual(h.$('architecture').getAttribute('viewBox'), before);
    await h.$('architecture').fire('keydown', { key: 'ArrowRight' });
    const manual = h.$('architecture').getAttribute('viewBox');
    await h.send([read, h.event('tool.requested', { toolCallId: 'new.call' })]);
    assert.equal(h.$('architecture').getAttribute('viewBox'), manual);
    h.$('follow-agent').checked = true; await h.$('follow-agent').fire('change'); await settle();
    await h.search('saveNote');
    const searched = h.$('architecture').getAttribute('viewBox');
    await h.send([read, h.event('tool.requested', { toolCallId: 'during.search' })]);
    assert.equal(h.$('architecture').getAttribute('viewBox'), searched);
    await h.search('');
    h.$('follow-agent').checked = false; await h.$('follow-agent').fire('change'); await settle();
    const unfollowed = h.$('architecture').getAttribute('viewBox');
    await h.send([h.event('tool.requested', { toolCallId: 'unfollowed' })]);
    assert.equal(h.$('architecture').getAttribute('viewBox'), unfollowed);
  } finally { h.close(); }
});

test('Follow reveals ancestors of an already-known active file, keeps that file collapsed, and respects Follow off', async () => {
  for (const follow of [true, false]) {
    const h = await harness();
    try {
      h.$('follow-agent').checked = follow; await h.$('follow-agent').fire('change'); await settle();
      assert.equal(h.$('group-layer').children.some(node => node.getAttribute('aria-label').startsWith('notes.js.')), false);
      const reads = h.requests.length;
      await h.send([h.event()]);
      const groups = h.$('group-layer').children;
      const parent = groups.find(node => node.getAttribute('aria-label').startsWith('src.'));
      const file = groups.find(node => node.getAttribute('aria-label').startsWith('notes.js.'));
      assert.match(parent.getAttribute('aria-label'), /Reading/);
      if (follow) {
        assert.match(parent.getAttribute('aria-label'), /Expanded/);
        assert.match(file.getAttribute('aria-label'), /Collapsed.*Reading/);
      } else {
        assert.match(parent.getAttribute('aria-label'), /Collapsed/);
        assert.equal(file, undefined);
      }
      assert.equal(h.requests.length, reads, 'revealing a known file never changes source scope or makes a request');
    } finally { h.close(); }
  }
});

test('strip resize notifications and window resizes preserve Follow-off or manually zoomed cameras', async () => {
  for (const { follow, zoom } of [{ follow: false, zoom: true }, { follow: true, zoom: true }, { follow: false, zoom: false }]) {
    const h = await harness();
    try {
      h.$('follow-agent').checked = follow; await h.$('follow-agent').fire('change'); await settle();
      await h.$('fit').fire('click');
      if (zoom) await h.$('zoom-in').fire('click');
      const camera = () => [h.$('architecture').getAttribute('viewBox'), h.$('zoom-level').textContent];
      const before = camera();
      const read = h.event(); await h.send([read]);
      assert.equal(h.$('current-activity').hidden, false);
      h.resize(900, 500);
      assert.deepEqual(camera(), before, 'showing the activity strip must not refit the camera');
      await h.send([h.event('tool.succeeded'), read]); await h.advance(4000);
      assert.equal(h.$('current-activity').hidden, true);
      h.resize(900, 540);
      assert.deepEqual(camera(), before, 'hiding the strip must not refit the camera');
      h.resize(650, 400, true);
      assert.deepEqual(camera(), before, 'a real window resize keeps the chosen viewport and zoom');
      await h.$('fit').fire('click');
      assert.notDeepEqual(camera(), before, 'the explicit Fit control still fits the new dimensions');
    } finally { h.close(); }
  }
});
