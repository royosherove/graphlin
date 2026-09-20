import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewPlatform } from '../../runtime/web/platform.js';
import { createDocument } from './fake-dom.mjs';
import { model, entity } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

test('installed view receives only the daemon projection after approval, and revocation clears/disposes it', async () => {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  const $ = id => document.getElementById(id), calls = [], deliveries = [], views = [], streams = [], analysisRequests = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map(); let timerId = 0;
  globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.EventSource = class {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.closed = true; }
  };
  const full = model({ rawSource: 'synthetic-host-only-content',
    checkpoints: [{ id: 'checkpoint.fixture', revision: 1, sequence: 1 }] });
  const projected = model({ entities: [entity('approved')], relations: [] });
  const installed = { id: 'example.fixture', digest: 'a'.repeat(64),
    manifest: { name: 'Fixture', graphlinApi: '1', modelSchema: '2', renderer: { kind: 'graphlin-scene' },
      capabilities: ['model.read', 'analysis.request', 'history.read'] },
    profiles: [{ id: 'grouping', selectors: { fields: ['entities'], candidateIds: [] } }], grant: null };
  let disposed = 0;
  const platform = createViewPlatform({
    document, onView: result => views.push(result), onSelect() {},
    async request(path, options) {
      calls.push(path);
      if (path.startsWith('/api/model/v1/snapshot')) return full;
      if (path === '/api/extensions') return { extensions: [structuredClone(installed)] };
      if (path === '/api/extensions/grant') {
        const body = JSON.parse(options.body);
        installed.grant = { ...body, extensionId: body.id, projectId: full.projectId };
        return { ok: true };
      }
      if (path === '/api/extensions/analysis') { analysisRequests.push(JSON.parse(options.body)); return { status: 'complete' }; }
      if (path.startsWith('/api/extensions/data/example.fixture')) {
        assert.equal(installed.grant.approved, true);
        return projected;
      }
      assert.fail(path);
    },
    createFrame() {
      return {
        update(input) {
          deliveries.push(input);
          return { kind: 'scene', scene: { sceneVersion: 1, groups: [], edges: [],
            nodes: [{ id: 'view.approved', entityId: 'approved', label: 'Approved', kind: 'module' }] } };
        },
        dispose() { disposed++; },
      };
    },
  });
  try {
    await platform.start(); await settle();
    platform.choose('example.fixture'); await settle();
    assert.equal($('extension-access').hidden, false);
    assert.equal(calls.some(path => path.includes('/data/')), false);
    assert.equal(deliveries.length, 0);
    $('extension-history').checked = true;
    await $('extension-approve').fire('click'); await settle();
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0].model, projected);
    assert.equal(deliveries[0].model.rawSource, undefined);
    assert.equal($('analysis-run').disabled, true);
    assert.deepEqual(analysisRequests, []);
    await $('analysis-access').fire('click');
    assert.match(markup, /This project must already allow source transmission/);
    $('extension-profiles').children[0].children[0].checked = true;
    await $('extension-approve').fire('click'); await settle();
    assert.equal($('analysis-run').disabled, false);
    platform.selected('run');
    await $('analysis-run').fire('click');
    assert.deepEqual(analysisRequests, [{ id: installed.id, digest: installed.digest, profileId: 'grouping', entityIds: ['run'], revision: 1 }]);
    platform.filter('api', null); await settle();
    assert.equal(analysisRequests.length, 1, 'filter/mount/update never triggers analysis');
    $('model-position').value = 'checkpoint.fixture';
    await $('model-position').fire('change'); await settle();
    assert.ok(streams.every(stream => stream.closed), 'checkpoint replay has no live model stream');
    const beforeRevocation = disposed;
    const dataCalls = calls.filter(path => path.includes('/data/')).length;
    installed.grant.approved = false;
    const [pollId, poll] = [...timers][0];
    timers.delete(pollId);
    await poll();
    await settle();
    assert.equal(disposed, beforeRevocation + 1);
    assert.equal(calls.filter(path => path.includes('/data/')).length, dataCalls);
    assert.equal(views.at(-1).clear, true);
    assert.equal($('extension-access').hidden, false);
    assert.equal(timers.size, 0, 'revocation stops grant polling');
  } finally {
    platform.close();
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else delete globalThis.EventSource;
  }
});
