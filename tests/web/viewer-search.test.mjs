import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  startViewer, filterDiagram, normalizeGraph, projectPresentation, createPresentation, graphBounds, fitViewport,
} from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, node, connectionInfo } from './fixtures.mjs';

function searchGraph(revision = 2) {
  return graph(revision, {
    nodes: [
      node('api', { label: 'Notes API' }),
      node('database', { label: 'Notes store' }),
      node('worker', { label: 'Worker', x: 1400, y: 1100 }),
    ],
    edges: [
      ...graph().edges,
      { ...graph().edges[0], id: 'worker-api', source: 'worker', target: 'api' },
    ],
  });
}

async function harness(initial = snapshot({ graph: searchGraph() })) {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id);
  const keys = ['document', 'window', 'fetch', 'EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map(), streams = [], timers = new Map(), frames = new Map(), calls = [];
  let current = initial, timerId = 0, exported;
  const createObjectURL = URL.createObjectURL;
  const createElement = document.createElement.bind(document);
  document.createElement = tag => {
    const element = createElement(tag);
    if (tag === 'a') element.click = () => {};
    return element;
  };
  URL.createObjectURL = blob => { exported = blob; return 'blob:fixture'; };
  const dimensions = { width: 920, height: 510 };
  $('architecture').getBoundingClientRect = () => dimensions;
  globalThis.document = document;
  globalThis.window = {
    location: { hash: '', pathname: '/', search: '' }, history: {},
    matchMedia: () => ({ matches: false }),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    requestAnimationFrame(callback) { const id = ++timerId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  globalThis.EventSource = class {
    constructor() { this.listeners = new Map(); streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() {}
  };
  globalThis.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.fetch = async url => {
    calls.push(url);
    if (url === '/api/about') return new Response('{}', { status: 404 });
    if (url.split('?')[0] === '/api/model/v1/snapshot' || url === '/api/extensions')
      return new Response('{}', { status: 404 });
    if (url === '/api/diagnostics') return new Response(JSON.stringify({ records: [] }));
    assert.ok(['/api/state', '/api/export', '/api/connection-info'].includes(url));
    return new Response(JSON.stringify(url === '/api/connection-info' ? connectionInfo() : current));
  };
  const viewer = startViewer();
  await viewer.ready;
  streams[0].emit('open');
  return {
    $, document, calls, frames,
    get current() { return current; },
    get exported() { return exported; },
    send(value = current) { current = value; streams[0].emit('snapshot', JSON.stringify(value)); },
    async search(value) { $('diagram-search').value = value; await $('diagram-search').fire('input'); },
    key(key, target = document.activeElement || document.body, options = {}) {
      let prevented = false;
      listeners.get('keydown')?.({ key, target, preventDefault() { prevented = true; }, ...options });
      return prevented;
    },
    typeButtons() { return new Map($('node-type-filters').children.map(button => [button.dataset.kind, button])); },
    async type(kind) {
      const button = this.typeButtons().get(kind);
      assert.ok(button, `type ${kind} is available`);
      await button.fire('click');
    },
    display(query = '', kinds = null, options = {}) {
      const view = Object.assign(createPresentation(), options);
      return projectPresentation(filterDiagram(normalizeGraph(current.graph), query, kinds), view, { arrange: true });
    },
    assertLayout(query = '', kinds = null, options = {}) {
      const expected = this.display(query, kinds, options);
      assert.equal($('node-layer').children.length, expected.nodes.length);
      for (const node of expected.nodes) {
        const group = $('node-layer').children.find(group => group.getAttribute('aria-label').startsWith(`${node.label}.`));
        assert.ok(group);
        assert.equal(group.getAttribute('transform'), `translate(${node.x} ${node.y})`);
        assert.equal(group.dataset.shape, node.shape);
      }
    },
    assertFit(query = '', kinds = null, options = {}) {
      const display = this.display(query, kinds, options);
      const expected = fitViewport(graphBounds(display), dimensions).viewport;
      assert.equal($('architecture').getAttribute('viewBox'), `${expected.x} ${expected.y} ${expected.width} ${expected.height}`);
    },
    assertNoEffects() {
      assert.equal($('effects-layer').children.length, 0);
      assert.ok($('node-layer').children.every(group => !group.visual.classList.contains('is-appearing')));
      assert.equal(frames.size, 0);
    },
    close() {
      viewer.close();
      assert.equal(listeners.has('keydown'), false);
      URL.createObjectURL = createObjectURL;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('search matches label substrings case-insensitively and retains only edges between matches without changing the graph', () => {
  const source = searchGraph();
  const original = structuredClone(source);
  for (const item of [...source.nodes, ...source.edges]) Object.freeze(item);
  Object.freeze(source.nodes); Object.freeze(source.edges); Object.freeze(source);
  const result = filterDiagram(source, 'oTeS');
  assert.deepEqual(result.nodes.map(node => node.id), ['api', 'database']);
  assert.deepEqual(result.edges.map(edge => edge.id), ['api-write-db']);
  assert.equal(filterDiagram(source, 'writes').nodes.length, 0, 'edge labels are not node labels');
  assert.equal(filterDiagram(source, 'service').nodes.length, 0, 'node kinds are not searched');
  assert.equal(filterDiagram(source, '').nodes.length, 3);
  assert.deepEqual(source, original);
});

test('typing filters, arranges and fits, and Escape restores without animation or camera arrival focus', async () => {
  const h = await harness();
  try {
    const startupRequests = [...h.calls];
    h.send(); // Establish live arrival baseline.
    const initialPositions = h.$('node-layer').children.map(group => group.getAttribute('transform'));
    assert.equal(h.key('/'), true);
    assert.equal(h.document.activeElement, h.$('diagram-search'));
    await h.search('oTeS');
    assert.equal(h.$('node-layer').children.length, 2);
    assert.equal(h.$('edge-layer').children.length, 1);
    assert.equal(h.$('edge-label-layer').children.length, 1);
    assert.equal(h.$('diagram-search-status').textContent, '2 of 3 components shown');
    h.assertFit('oTeS');
    h.assertLayout('oTeS');
    h.assertNoEffects();
    await h.search('<nothing>');
    assert.equal(h.$('node-layer').children.length, 0);
    assert.equal(h.$('edge-label-layer').children.length, 0);
    assert.equal(h.$('empty-canvas').hidden, false);
    assert.equal(h.$('empty-title').textContent, 'No matching components.');
    assert.match(h.$('empty-description').textContent, /<nothing>.*Esc/);
    assert.equal(h.$('empty-description').children.length, 0);
    assert.equal(h.$('orientation').hidden, true);
    h.send();
    assert.equal(h.$('orientation').hidden, true, 'connection updates preserve search empty state');
    assert.equal(h.key('Escape'), true);
    assert.equal(h.$('diagram-search').value, '');
    assert.equal(h.document.activeElement, h.$('diagram-search'));
    assert.deepEqual(h.$('node-layer').children.map(group => group.getAttribute('transform')), initialPositions);
    assert.equal(h.$('edge-layer').children.length, 2);
    assert.equal(h.$('empty-canvas').hidden, true);
    h.assertFit();
    h.assertLayout();
    h.assertNoEffects();
    assert.equal(h.key('Escape'), false);
    assert.deepEqual(h.calls, startupRequests, 'search makes no server mutations or requests');
  } finally { h.close(); }
});

test('search and type predicates intersect, including clear all, without mutating source nodes or edges', () => {
  const source = searchGraph();
  const original = structuredClone(source);
  for (const item of [...source.nodes, ...source.edges]) Object.freeze(item);
  Object.freeze(source.nodes); Object.freeze(source.edges); Object.freeze(source);
  assert.deepEqual(filterDiagram(source, 'Notes', new Set(['datastore'])).nodes.map(node => node.id), ['database']);
  assert.deepEqual(filterDiagram(source, '', new Set(['service'])).edges, []);
  assert.deepEqual(filterDiagram(source, '', new Set()).nodes, []);
  assert.deepEqual(filterDiagram(source, '', new Set()).edges, []);
  assert.deepEqual(source, original);
});

test('filtering packs only the visible graph with Auto off and preserves algorithm and shape overrides', async () => {
  const source = graph(2, {
    nodes: Array.from({ length: 9 }, (_, index) => node(`item-${index}`, {
      label: `${index % 2 ? 'Hidden' : 'Found'} ${index}`, kind: index % 3 ? 'service' : 'datastore',
      x: index * 310, y: index * 180,
    })),
    edges: Array.from({ length: 8 }, (_, index) => ({
      ...graph().edges[0], id: `edge-${index}`, source: `item-${index}`, target: `item-${index + 1}`,
    })),
  });
  const original = structuredClone(source);
  const h = await harness(snapshot({ graph: source }));
  try {
    h.send();
    h.$('auto-arrange').checked = false;
    await h.$('auto-arrange').fire('change');
    await h.$('node-layer').children[0].fire('click');
    h.$('display-shape').value = 'diamond';
    await h.$('display-shape').fire('change');
    const shapes = new Map([['item-0', 'diamond']]);
    for (const algorithm of ['hierarchy', 'dependency', 'grouped', 'circular', 'grid', 'original']) {
      h.$('layout').value = algorithm;
      await h.$('layout').fire('change');
      await h.search('Found');
      h.assertLayout('Found', null, { algorithm, shapes });
      h.assertFit('Found', null, { algorithm, shapes });
      h.assertNoEffects();
      assert.equal(h.$('auto-arrange').checked, false);
      await h.type('service');
      h.assertLayout('Found', new Set(['datastore']), { algorithm, shapes });
      h.assertFit('Found', new Set(['datastore']), { algorithm, shapes });
      h.assertNoEffects();
      assert.equal(h.key('Escape', h.$('diagram-search')), true);
      h.assertLayout('', new Set(['datastore']), { algorithm, shapes });
      h.assertFit('', new Set(['datastore']), { algorithm, shapes });
      h.assertNoEffects();
      await h.$('node-types-all').fire('click');
      h.assertLayout('', null, { algorithm, shapes });
      h.assertFit('', null, { algorithm, shapes });
      h.assertNoEffects();
    }
    assert.deepEqual(h.current.graph, original);
    await h.$('export').fire('click');
    assert.deepEqual(JSON.parse(await h.exported.text()).graph, normalizeGraph(original, { includeExcerpts: false }),
      'arrangement and shape overrides stay out of exports, with the existing excerpt redaction preserved');
  } finally { h.close(); }
});

test('type buttons use canonical kinds, intersect search, retain focus, and clear all keeps an empty canvas', async () => {
  const h = await harness();
  try {
    h.send();
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'service']);
    assert.ok([...h.typeButtons().values()].every(button => button.getAttribute('aria-pressed') === 'true'));
    await h.search('Worker');
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'service'], 'search does not shrink the type palette');
    const datastore = h.typeButtons().get('datastore');
    datastore.focus();
    await h.type('datastore');
    assert.equal(h.document.activeElement, datastore);
    assert.equal(h.typeButtons().get('datastore'), datastore);
    assert.equal(datastore.getAttribute('aria-pressed'), 'false');
    assert.equal(h.$('node-layer').children.length, 0);
    assert.equal(h.$('edge-layer').children.length, 0);
    assert.equal(h.$('diagram-search-status').textContent, '0 of 3 components shown');
    assert.equal(h.key('Escape', datastore), true);
    h.assertLayout('', new Set(['service']));
    h.assertFit('', new Set(['service']));
    h.assertNoEffects();
    await h.$('node-types-none').fire('click');
    assert.equal(h.$('node-layer').children.length, 0);
    assert.equal(h.$('edge-label-layer').children.length, 0);
    assert.equal(h.$('empty-title').textContent, 'No component types selected.');
    assert.match(h.$('empty-description').textContent, /All types/);
    assert.equal(h.$('orientation').hidden, true);
    const next = structuredClone(h.current);
    next.graph.nodes.push(node('queue', { kind: 'queue', label: 'Notes queue' }));
    h.send(next);
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'queue', 'service']);
    assert.ok([...h.typeButtons().values()].every(button => button.getAttribute('aria-pressed') === 'false'));
    assert.equal(h.$('node-layer').children.length, 0, 'new kinds do not undo Clear all');
    assert.equal(h.$('orientation').hidden, true);
    h.assertNoEffects();
    await h.search('Notes');
    assert.equal(h.key('Escape', h.$('diagram-search')), true);
    assert.equal(h.$('node-layer').children.length, 0, 'Escape preserves the empty type selection');
    await h.search('Worker');
    await h.$('node-types-all').fire('click');
    h.assertLayout('Worker');
    h.assertFit('Worker');
    h.assertNoEffects();
  } finally { h.close(); }
});

test('type selection survives kind changes and replay, and defaults to all for another session', async () => {
  const h = await harness();
  try {
    await h.type('datastore');
    const next = structuredClone(h.current);
    next.graph.nodes = next.graph.nodes.filter(node => node.kind !== 'service');
    next.graph.nodes.push(node('queue', { kind: 'queue', label: 'Notes queue' }));
    h.send(next);
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'queue']);
    assert.equal(h.$('node-layer').children.length, 0, 'a new kind is not added to a custom selection');
    const restored = structuredClone(next);
    restored.graph.nodes.push(node('api'));
    h.send(restored);
    assert.equal(h.typeButtons().get('service').getAttribute('aria-pressed'), 'true', 'returning kinds retain their selection');
    assert.equal(h.$('node-layer').children.length, 1);
    await h.$('replay').fire('click');
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'service'], 'only kinds in the replay canvas are shown');
    assert.equal(h.$('node-layer').children.length, 1);
    await h.$('live').fire('click');
    assert.deepEqual([...h.typeButtons().keys()], ['datastore', 'queue', 'service']);
    h.assertNoEffects();
    await h.$('node-types-all').fire('click');
    const more = structuredClone(h.current);
    more.graph.nodes.push(node('client', { kind: 'client', label: 'Notes client' }));
    h.send(more);
    assert.equal(h.typeButtons().get('client').getAttribute('aria-pressed'), 'true', 'All types includes newly arriving kinds');
    await h.$('node-types-none').fire('click');
    h.send(snapshot({ sessionId: 'session-2', graph: graph(1, { nodes: [node('configuration', { kind: 'configuration' })], edges: [] }) }));
    assert.deepEqual([...h.typeButtons().keys()], ['configuration']);
    assert.equal(h.typeButtons().get('configuration').getAttribute('aria-pressed'), 'true');
    assert.equal(h.$('node-layer').children.length, 1);
    h.assertNoEffects();
  } finally { h.close(); }
});

test('search shortcuts respect other fields, editable descendants, dialogs, modifiers and composition', async () => {
  const h = await harness();
  try {
    await h.search('Notes');
    for (const tag of ['input', 'textarea', 'select']) {
      const target = h.document.createElement(tag);
      target.focus();
      assert.equal(h.key('/'), false);
      assert.equal(h.key('Escape'), false);
      assert.equal(h.document.activeElement, target);
    }
    for (const attributes of [{ contenteditable: '' }, { contenteditable: 'plaintext-only' }, { role: 'textbox' }]) {
      const editable = h.document.createElement('div');
      for (const [key, value] of Object.entries(attributes)) editable.setAttribute(key, value);
      const child = h.document.createElement('span');
      editable.append(child);
      assert.equal(h.key('/', child), false);
      assert.equal(h.key('Escape', child), false);
    }
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
      assert.equal(h.key('/', h.document.body, options), false);
      assert.equal(h.key('Escape', h.document.body, options), false);
    }
    for (const [id, trigger] of [['connection-dialog', 'how-to-connect'], ['diagnostics-dialog', 'classification-log']]) {
      const dialog = h.$(id);
      await h.$(trigger).fire('click');
      assert.equal(dialog.open, true);
      assert.equal(h.key('/', h.document.body), false);
      assert.equal(h.key('Escape', h.document.body), false);
      await dialog.fire('keydown', { key: 'Escape' });
      assert.equal(dialog.open, false, 'the existing dialog Escape handler still closes it');
      assert.equal(h.$('diagram-search').value, 'Notes');
    }
    assert.equal(h.key('/', h.$('diagram-search')), false, 'slash can be typed in search');
    const component = h.$('node-layer').children[0];
    await component.fire('keydown', { key: 'Enter' });
    assert.equal(component.getAttribute('aria-pressed'), 'true');
    assert.equal(h.key('Escape', component), true);
    assert.equal(h.document.activeElement, h.$('diagram-search'));
  } finally { h.close(); }
});

test('filtered live arrivals and removals stay source-based and clearing never replays hidden arrivals', async () => {
  const h = await harness();
  try {
    h.send();
    const next = structuredClone(h.current);
    next.graph.nodes.push(node('new', { label: 'Notes new' }));
    h.send(next);
    assert.ok(h.$('node-layer').children.some(group => group.visual.classList.contains('is-appearing')));
    await h.search('worker');
    h.assertNoEffects();
    const hiddenArrival = structuredClone(h.current);
    hiddenArrival.graph.nodes.push(node('hidden', { label: 'Hidden addition' }));
    h.send(hiddenArrival);
    assert.equal(h.$('node-layer').children.length, 1);
    h.assertNoEffects();
    await h.$('diagram-search-clear').fire('click');
    assert.equal(h.$('node-layer').children.length, 5);
    h.assertFit();
    h.assertNoEffects();
    const removed = structuredClone(h.current);
    removed.graph.nodes = removed.graph.nodes.filter(node => node.id !== 'new');
    h.send(removed);
    assert.equal(h.$('effects-layer').children.length, 1, 'real source removals still animate');
    await h.search('Notes');
    h.assertNoEffects();
    h.assertFit('Notes');
  } finally { h.close(); }
});

test('real matching arrivals immediately after typing and clearing still focus and pop without animating restored nodes', async () => {
  const h = await harness();
  try {
    h.send();
    const assertArrival = label => {
      const appearing = h.$('node-layer').children.filter(group => group.visual.classList.contains('is-appearing'));
      assert.equal(appearing.length, 1, 'only the actual new node gets an arrival effect');
      assert.ok(appearing[0].getAttribute('aria-label').startsWith(`${label}.`));
      const [nodeX, nodeY] = appearing[0].getAttribute('transform').match(/[-\d.]+/g).map(Number);
      const [x, y, width, height] = h.$('architecture').getAttribute('viewBox').split(' ').map(Number);
      assert.ok(Math.abs(x + width / 2 - (nodeX + 95)) < 1e-7, 'camera centers the actual arrival horizontally');
      assert.ok(Math.abs(y + height / 2 - (nodeY + 52)) < 1e-7, 'camera centers the actual arrival vertically');
      assert.equal(h.$('effects-layer').children.length, 0);
    };
    await h.search('Notes');
    const first = structuredClone(h.current);
    first.graph.nodes.push(node('first-arrival', { label: 'Notes first arrival' }));
    h.send(first);
    assertArrival('Notes first arrival');
    assert.equal(h.key('Escape', h.$('diagram-search')), true);
    assert.equal(h.$('node-layer').children.length, 4, 'clearing restores the hidden existing worker');
    h.assertNoEffects();
    h.assertFit();
    const second = structuredClone(h.current);
    second.graph.nodes.push(node('second-arrival', { label: 'Notes second arrival' }));
    h.send(second);
    assertArrival('Notes second arrival');
  } finally { h.close(); }
});

test('type changes never synthesize arrivals or removals, while actual visible arrivals still focus and animate', async () => {
  const h = await harness();
  try {
    h.send();
    await h.type('datastore');
    await h.search('Notes');
    h.assertNoEffects();
    const next = structuredClone(h.current);
    next.graph.nodes.push(
      node('new-service', { kind: 'service', label: 'Notes arrival' }),
      node('new-store', { kind: 'datastore', label: 'Notes hidden arrival' }),
    );
    h.send(next);
    const appearing = h.$('node-layer').children.filter(group => group.visual.classList.contains('is-appearing'));
    assert.equal(appearing.length, 1);
    assert.ok(appearing[0].getAttribute('aria-label').startsWith('Notes arrival.'));
    const [nodeX, nodeY] = appearing[0].getAttribute('transform').match(/[-\d.]+/g).map(Number);
    const [x, y, width, height] = h.$('architecture').getAttribute('viewBox').split(' ').map(Number);
    assert.ok(Math.abs(x + width / 2 - (nodeX + 95)) < 1e-7, 'last visible arrival receives horizontal focus even when a later arrival is hidden');
    assert.ok(Math.abs(y + height / 2 - (nodeY + 52)) < 1e-7);
    assert.equal(h.$('effects-layer').children.length, 0);
    await h.$('node-types-all').fire('click');
    h.assertNoEffects();
    h.assertFit('Notes');
    await h.type('datastore');
    h.assertNoEffects();
    const hiddenRemoval = structuredClone(h.current);
    hiddenRemoval.graph.nodes = hiddenRemoval.graph.nodes.filter(node => node.id !== 'new-store');
    h.send(hiddenRemoval);
    h.assertNoEffects();
    const visibleRemoval = structuredClone(h.current);
    visibleRemoval.graph.nodes = visibleRemoval.graph.nodes.filter(node => node.id !== 'new-service');
    h.send(visibleRemoval);
    assert.equal(h.$('effects-layer').children.length, 1, 'actual visible removals still animate');
    await h.$('node-types-none').fire('click');
    h.assertNoEffects();
    assert.equal(h.$('node-layer').children.length, 0);
  } finally { h.close(); }
});

test('replay applies search and types while export includes the complete server graph and history', async () => {
  const h = await harness();
  try {
    await h.search('Notes');
    await h.type('datastore');
    await h.$('replay').fire('click');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    assert.equal(h.$('node-layer').children.length, 1);
    assert.equal(h.$('edge-layer').children.length, 0);
    await h.$('export').fire('click');
    const exported = JSON.parse(await h.exported.text());
    assert.equal(exported.graph.nodes.length, 3);
    assert.equal(exported.graph.edges.length, 2);
    assert.equal(exported.history[0].graph.nodes.length, 2);
    assert.deepEqual(exported.graph, normalizeGraph(h.current.graph, { includeExcerpts: false }));
    assert.ok(h.calls.includes('/api/export'));
    await h.$('live').fire('click');
    assert.equal(h.$('node-layer').children.length, 1);
    h.assertNoEffects();
  } finally { h.close(); }
});
