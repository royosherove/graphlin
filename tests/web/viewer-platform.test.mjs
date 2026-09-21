import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, connectionInfo } from './fixtures.mjs';
import { model, entity, ref } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
async function harness() {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id), streams = [], calls = [];
  const keys = ['document', 'window', 'fetch', 'EventSource'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let current = model(), baseline = null;
  globalThis.document = document;
  globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: {},
    matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} };
  globalThis.EventSource = class {
    constructor(path) { this.path = path; this.listeners = {}; streams.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() { this.closed = true; }
    emit(value) { this.listeners.snapshot?.({ data: JSON.stringify(value) }); }
  };
  globalThis.fetch = async (path, options) => {
    calls.push([path, options]);
    let result;
    if (path === '/api/state') result = snapshot();
    else if (path === '/api/connection-info') result = connectionInfo();
    else if (path === '/api/extensions') result = { extensions: [] };
    else if (path.startsWith('/api/model/v1/snapshot')) result = path.includes('checkpoint=') ? baseline : current;
    else if (path === '/api/model/v1/checkpoints') {
      baseline = structuredClone(current);
      current = { ...current, checkpoints: [{ id: 'checkpoint.task', label: 'Task baseline', revision: current.revision }] };
      result = current.checkpoints[0];
    } else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(result));
  };
  const viewer = startViewer();
  await viewer.ready; await settle();
  return {
    $, document, calls, streams,
    get current() { return current; },
    async choose(value) { $('visualizer').value = value; await $('visualizer').fire('change'); await settle(); },
    async send(value) {
      current = value; streams.filter(stream => stream.path.startsWith('/api/model/') && !stream.closed).at(-1).emit(value);
      await settle();
    },
    async search(value) { $('diagram-search').value = value; await $('diagram-search').fire('input'); await settle(); },
    close() {
      viewer.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test('viewer switches code, blocks, C4 and activity through one model, preserving theme and source selection', async () => {
  const h = await harness();
  try {
    assert.equal(h.$('node-layer').children.length, 5);
    h.$('theme').value = 'midnight'; await h.$('theme').fire('change');
    const run = h.$('node-layer').children.find(node => node.getAttribute('aria-label').startsWith('run.'));
    await run.fire('click');
    assert.match(h.$('inspector-body').textContent, /Parsed source/);
    await h.choose('graphlin.blocks');
    assert.equal(h.$('group-layer').children.length, 3);
    assert.equal(h.$('node-layer').children.length, 0);
    const api = h.$('group-layer').children.find(node => node.getAttribute('aria-label').startsWith('api.'));
    assert.equal(api.getAttribute('aria-pressed'), 'true');
    await h.search('save');
    assert.equal(h.$('node-layer').children.length, 1);
    assert.equal(h.$('group-layer').children.length, 2);
    await h.search('');
    await h.choose('graphlin.c4');
    assert.match(h.$('view-coverage').textContent, /unknown/);
    await h.choose('graphlin.timeline');
    assert.equal(h.$('custom-view').hidden, false);
    assert.equal(h.$('architecture').hidden, true);
    assert.equal(h.$('arrange').disabled, true);
    assert.match(h.$('custom-view').textContent, /No observations/);
    await h.choose('graphlin.code');
    assert.equal(h.$('drawing').dataset.theme, 'midnight');
    assert.equal(h.calls.filter(([path]) => path === '/api/control').length, 0);
  } finally { h.close(); }
});

test('follow off keeps the camera fixed; follow on restores arrival focus', async () => {
  const h = await harness();
  try {
    h.$('follow-agent').checked = false;
    await h.$('follow-agent').fire('change'); await settle();
    const before = h.$('architecture').getAttribute('viewBox');
    await h.send(model({ revision: 2, sequence: 2, entities: [...h.current.entities, entity('new')] }));
    assert.equal(h.$('architecture').getAttribute('viewBox'), before);
    h.$('follow-agent').checked = true;
    await h.$('follow-agent').fire('change'); await settle();
    await h.send(model({ revision: 3, sequence: 3, entities: [...h.current.entities, entity('next')] }));
    assert.notEqual(h.$('architecture').getAttribute('viewBox'), before);
  } finally { h.close(); }
});

test('a named baseline is created only by the explicit action and retained replay uses the checkpoint query', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.changes');
    assert.match(h.$('view-coverage').textContent, /Choose.*baseline/);
    await h.$('baseline-create').fire('click'); await settle();
    assert.equal(h.calls.filter(([path, options]) => path === '/api/model/v1/checkpoints' && options.method === 'POST').length, 1);
    assert.equal(h.$('task-baseline').value, 'checkpoint.task');
    assert.match(h.$('view-coverage').textContent, /Since revision 1/);
    h.$('model-position').value = 'checkpoint.task';
    await h.$('model-position').fire('change'); await settle();
    assert.ok(h.calls.some(([path]) => {
      const query = new URL(path, 'http://fixture').searchParams;
      return query.get('checkpoint') === 'checkpoint.task' && query.get('session') === 'session-1';
    }));
    assert.ok(h.streams.filter(stream => stream.path.startsWith('/api/model/')).every(stream => stream.closed));
  } finally { h.close(); }
});

test('baseline creation includes the selected session and is disabled during checkpoint replay', async () => {
  const h = await harness();
  try {
    h.$('session').value = 'session.one';
    await h.$('session').fire('change'); await settle();
    await h.choose('graphlin.changes');
    await h.$('baseline-create').fire('click'); await settle();
    const posts = () => h.calls.filter(([path]) => path === '/api/model/v1/checkpoints');
    assert.deepEqual(JSON.parse(posts()[0][1].body), { label: 'Task baseline', sessionId: 'session.one' });
    assert.ok(h.calls.some(([path]) => path.includes('/snapshot?session=session.one')));
    h.$('model-position').value = 'checkpoint.task';
    await h.$('model-position').fire('change');
    assert.equal(h.$('baseline-create').disabled, true, 'disable before the historical snapshot arrives');
    await settle();
    assert.equal(h.$('baseline-create').disabled, true);
    await h.$('baseline-create').fire('click'); await settle();
    assert.equal(posts().length, 1);
  } finally { h.close(); }
});

test('C4 displays newly supported boundaries from model updates without another discovery request', async () => {
  const h = await harness();
  try {
    await h.choose('graphlin.c4');
    assert.match(h.$('view-coverage').textContent, /unknown/);
    await h.send(model({ revision: 2, sequence: 2, interpretations: [{
      id: 'boundary.live', namespace: 'graphlin.architecture', kind: 'application',
      label: 'Notes application', entityIds: ['api'], sourceRefs: [ref()],
      support: 'supported', classification: 'accepted', validity: 'current',
    }] }));
    assert.ok(h.$('group-layer').children.some(group => group.getAttribute('aria-label').startsWith('Notes application.')));
    assert.equal(h.calls.some(([path]) => path === '/api/architecture/discover'), false);
    assert.equal(h.calls.some(([path]) => path === '/api/extensions/grant'), false);
  } finally { h.close(); }
});

test('nested C4 groups sharing a source member expand independently through their stable group IDs', async () => {
  const h = await harness();
  try {
    await h.send(model({ revision: 2, sequence: 2, interpretations: [
      { id: 'app', namespace: 'example.boundaries', kind: 'application', label: 'Application',
        entityIds: ['api', 'run', 'store', 'save'], sourceRefs: [ref()],
        support: 'supported', classification: 'accepted', validity: 'current' },
      { id: 'component', namespace: 'example.boundaries', kind: 'component', label: 'Component',
        entityIds: ['api', 'run'], sourceRefs: [ref()],
        support: 'supported', classification: 'accepted', validity: 'current' },
    ] }));
    await h.choose('graphlin.c4');
    const groups = () => h.$('group-layer').children;
    const application = () => groups().find(group => group.getAttribute('aria-label').startsWith('Application.'));
    const component = () => groups().find(group => group.getAttribute('aria-label').startsWith('Component.'));
    assert.match(application().getAttribute('aria-label'), /Expanded/);
    assert.match(component().getAttribute('aria-label'), /Collapsed/);
    await component().querySelector('[aria-label="Expand Component"]').fire('keydown', { key: 'Enter' }); await settle();
    assert.match(component().getAttribute('aria-label'), /Expanded/);
    assert.match(application().getAttribute('aria-label'), /Expanded/);
    assert.ok(h.$('node-layer').children.some(node => node.getAttribute('aria-label').startsWith('run.')));
    await application().querySelector('[aria-label="Collapse Application"]').fire('click'); await settle();
    assert.equal(component(), undefined);
  } finally { h.close(); }
});
