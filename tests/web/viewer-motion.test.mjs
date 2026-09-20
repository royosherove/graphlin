import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer, graphBounds, graphEdgeRoutes, normalizeGraph, sanitizedExport, SHAPE_NAMES, THEME_NAMES } from '../../runtime/web/app.js';
import { sketchOutline, sketchDetails, sketchConnection } from '../../runtime/web/sketch.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, node, connectionInfo } from './fixtures.mjs';
import { captureDemoStream } from './demo-stream-fixture.mjs';

async function harness(initial = snapshot()) {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  const $ = id => document.getElementById(id);
  const capturedPointers = new Set(), releasedPointers = [];
  const canvas = $('architecture');
  canvas.closest = () => null;
  canvas.getBoundingClientRect = () => ({ width: 920, height: 510 });
  canvas.setPointerCapture = id => capturedPointers.add(id);
  canvas.hasPointerCapture = id => capturedPointers.has(id);
  canvas.releasePointerCapture = id => {
    capturedPointers.delete(id);
    releasedPointers.push(id);
  };
  const keys = ['document', 'window', 'fetch', 'EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let current = initial, now = 0, nextId = 0;
  const timers = new Map(), frames = new Map(), streams = [], requests = [];
  const listeners = new Map();
  const media = {
    matches: false, listener: null,
    addEventListener(_type, listener) { this.listener = listener; },
    removeEventListener() { this.listener = null; },
    change(value) { this.matches = value; this.listener?.(); },
  };
  const window = {
    location: { hash: '', pathname: '/', search: '' }, history: {},
    matchMedia: () => media,
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  class EventSource {
    constructor() { this.listeners = new Map(); streams.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() { this.closed = true; }
  }
  globalThis.document = document;
  globalThis.window = window;
  globalThis.EventSource = EventSource;
  globalThis.setTimeout = (callback, duration) => { const id = ++nextId; timers.set(id, { callback, at: now + duration }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/about') return new Response('{}', { status: 404 });
    if (url === '/api/connection-info') return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(connectionInfo()) };
    if (url === '/api/control') {
      const command = JSON.parse(options.body);
      if (command.action === 'session') current = { ...current, sessionId: command.sessionId };
      else current = { ...current, paused: command.action === 'pause' };
      return { ok: true, headers: { get: () => null }, text: async () => '{}' };
    }
    assert.equal(url, '/api/state');
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(current) };
  };
  const viewer = startViewer();
  await viewer.ready;
  streams[0].emit('open');
  return {
    $, document, media, timers, frames, streams, requests, capturedPointers, releasedPointers,
    stop() { viewer.close(); },
    get current() { return current; },
    send(value) { current = value; streams.at(-1).emit('snapshot', JSON.stringify(value)); },
    hide(value) { document.hidden = value; document.fire('visibilitychange'); },
    windowEvent(type, value = {}) { listeners.get(type)?.(value); },
    frame(timestamp) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(timestamp);
    },
    advance(duration) {
      now += duration;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
    close() {
      viewer.close();
      assert.equal(frames.size, 0, 'teardown cancels animation frames');
      assert.equal(timers.size, 0, 'teardown cancels every effect and fallback timer');
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function nodeGroup(h, label) {
  return h.$('node-layer').children.find(group => group.getAttribute('aria-label').startsWith(`${label}.`));
}
function appearing(h) { return h.$('node-layer').children.filter(group => group.visual.classList.contains('is-appearing')); }
function changed(h, nodes, edges = []) {
  return { ...h.current, graph: graph(h.current.graph.revision + 1, { nodes, edges }) };
}
function positions(h) {
  return h.$('node-layer').children.map(group => {
    const [x, y] = group.getAttribute('transform').match(/[-\d.]+/g).map(Number);
    return { x, y };
  });
}

function viewport(h) {
  const [x, y, width, height] = h.$('architecture').getAttribute('viewBox').split(' ').map(Number);
  return { x, y, width, height };
}

function assertGraphFits(h) {
  const projected = normalizeGraph(h.current.graph);
  const points = positions(h);
  projected.nodes.forEach((node, index) => Object.assign(node, points[index]));
  const bounds = graphBounds(projected);
  const view = viewport(h);
  const size = h.$('architecture').getBoundingClientRect();
  const epsilon = 1e-7;
  assert.ok(view.x <= bounds.x + epsilon && view.y <= bounds.y + epsilon &&
    view.x + view.width >= bounds.x + bounds.width - epsilon &&
    view.y + view.height >= bounds.y + bounds.height - epsilon,
  'the viewport contains every shape, arrow, and label');
  assert.ok(Math.abs(view.width / view.height - size.width / size.height) < epsilon,
    'the viewBox matches the actual canvas aspect ratio');
  assert.ok(Math.abs(size.width / view.width - Math.min(4, size.width / bounds.width, size.height / bounds.height)) < epsilon,
    'the fitted camera uses the available canvas without clipping');
}

function sketchGroup(group) { return group.content.children.find(child => child.className === 'node-sketch'); }
function detailGroup(group) { return group.content.children.find(child => child.classList.contains('node-sketch-details')); }
function sketchPaths(group) { return group.children.map(path => path.getAttribute('d')); }
function connectionPaths(group) {
  return {
    lines: [group.line, group.secondaryLine].map(path => path.getAttribute('d')),
    heads: group.heads.map(path => path.getAttribute('d')),
  };
}
function assertConnectionGeometry(h, group, id) {
  const displayed = normalizeGraph(h.current.graph);
  const points = positions(h);
  displayed.nodes.forEach((node, index) => Object.assign(node, points[index]));
  const route = graphEdgeRoutes(displayed).get(id);
  assert.equal(group.hit.getAttribute('d'), route.d, 'interaction follows the canonical cubic');
  assert.deepEqual(connectionPaths(group), sketchConnection(route.points, id), 'both shafts and heads follow the displayed route with a stable identity seed');
  assert.notEqual(group.line.getAttribute('d'), route.d, 'visible ink does not reuse the canonical hit path');
  assert.equal(group.leader.getAttribute('d'), route.leader || '');
  assert.equal(group.control.getAttribute('transform'), `translate(${route.x} ${route.y}) rotate(${route.angle})`);
}

test('real demo IPC and SSE bursts preserve node DOM identities and deliver three inflate/pop cycles through status snapshots', async t => {
  const { initial, frames } = await captureDemoStream();
  assert.equal(initial.graph.nodes.length, 18);
  assert.equal(frames[0].graph.nodes.length, 18, 'the immediate SSE event establishes the same baseline');
  assert.ok(frames.some(frame => frame.status.pending > 0), 'capture/classification status events are included');
  assert.ok(frames.every(frame => frame.sessionId === initial.sessionId && frame.projectId === initial.projectId && frame.mode === 'demo'));
  const h = await harness(initial);
  try {
    const survivors = [...h.$('node-layer').children];
    const visuals = survivors.map(group => group.visual);
    let count = 18, arrivals = 0, removals = 0;
    for (const frame of frames) {
      const previousEffects = [...h.$('effects-layer').children];
      const previousArrivals = appearing(h);
      h.send(frame);
      assert.equal(h.$('error-banner').textContent, '');
      assert.equal(h.$('connection').dataset.state, 'connected');
      for (const [index, group] of survivors.entries()) {
        assert.ok(h.$('node-layer').children.includes(group), 'survivors retain their semantic button identity');
        assert.equal(group.visual, visuals[index], 'nested animation targets are not replaced');
      }
      if (frame.graph.nodes.length > count) {
        arrivals++;
        assert.equal(appearing(h).length, 2, 'both actual new canonical IDs receive an inflate class');
        assert.equal(h.$('effects-layer').children.length, 0, 'same-ID re-add clears old decorations');
      } else if (frame.graph.nodes.length < count) {
        removals++;
        assert.equal(appearing(h).length, 0);
        assert.equal(h.$('effects-layer').children.length, 2);
        assert.equal(h.$('node-layer').children.length, 18, 'removed nodes leave hit/evidence targets immediately');
        const view = viewport(h);
        for (const burst of h.$('effects-layer').children) {
          const [x, y] = burst.getAttribute('transform').match(/[-\d.]+/g).map(Number);
          assert.ok(x - 128 >= view.x && x + 128 <= view.x + view.width &&
            y - 110 >= view.y && y + 110 <= view.y + view.height,
          'real demo removals keep their expanding outlines and particles inside the temporary fit');
        }
      } else {
        assert.deepEqual(appearing(h), previousArrivals, 'status snapshots do not cancel or restart arrivals');
        assert.deepEqual([...h.$('effects-layer').children], previousEffects, 'status snapshots retain the same burst elements');
      }
      count = frame.graph.nodes.length;
    }
    assert.equal(arrivals, 3);
    assert.equal(removals, 3);
    h.advance(500);
    assert.equal(h.$('effects-layer').children.length, 0);
    assertGraphFits(h);
    t.diagnostic(`${frames.length} real SSE snapshots; 3 × 18→20→18; stable session, stream and surviving DOM targets. CSS/visibility still requires parent browser validation.`);
  } finally { h.close(); }
});

test('all eight themes recolor a live view without rebuilding geometry, evidence, selection or outlines', async () => {
  const initial = snapshot();
  const unchanged = structuredClone(initial);
  const exported = sanitizedExport(initial);
  const h = await harness(initial);
  try {
    h.send(h.current);
    const nodes = [...h.$('node-layer').children];
    const content = nodes.map(group => [...group.content.children]);
    const outlines = nodes.map(sketchGroup);
    const edges = [...h.$('edge-layer').children];
    const paths = edges.map(connectionPaths);
    await nodes[0].fire('click');
    await h.$('zoom-in').fire('click');
    const viewport = h.$('architecture').getAttribute('viewBox');
    const inspector = [...h.$('inspector-body').children];
    for (const theme of Object.keys(THEME_NAMES)) {
      h.$('theme').value = theme;
      h.$('theme').focus();
      await h.$('theme').fire('change');
      assert.equal(h.$('drawing').dataset.theme, theme);
      assert.equal(h.document.activeElement, h.$('theme'));
      assert.deepEqual([...h.$('node-layer').children], nodes);
      assert.deepEqual([...h.$('edge-layer').children], edges);
      assert.deepEqual(nodes.map(group => [...group.content.children]), content);
      assert.deepEqual(edges.map(connectionPaths), paths);
      assert.deepEqual([...h.$('inspector-body').children], inspector);
      assert.equal(nodes[0].getAttribute('aria-pressed'), 'true');
      assert.equal(h.$('architecture').getAttribute('viewBox'), viewport);
      assert.equal(h.frames.size, 0);
    }
    for (const [index, outline] of outlines.entries()) {
      assert.equal(outline.getAttribute('fill'), 'none');
      assert.equal(outline.getAttribute('aria-hidden'), 'true');
      assert.equal(outline.getAttribute('pointer-events'), 'none');
      assert.equal(outline.children.length, 2);
      assert.ok(content[index].indexOf(outline) < content[index].findIndex(child => child.className === 'node-role'));
    }
    h.$('theme').value = 'url(https://untrusted.invalid/theme)';
    await h.$('theme').fire('change');
    assert.equal(h.$('theme').value, 'midnight');
    h.send({ ...h.current, theme: 'sunset', graph: { ...h.current.graph, theme: 'ocean' } });
    assert.equal(h.$('drawing').dataset.theme, 'midnight', 'snapshots cannot supply presentation tokens');
    assert.deepEqual(nodes.map(sketchGroup), outlines);
    assert.deepEqual(h.requests.map(request => request.url), ['/api/state', '/api/connection-info', '/api/about'], 'theme changes never make service calls');
    assert.deepEqual(initial, unchanged);
    assert.deepEqual(sanitizedExport(h.current), exported, 'presentation cannot enter canonical JSON exports');
  } finally { h.close(); }
});

test('rough detail seams replace canonical inner strokes while fills, browser dots, symbols and replay identities survive', async () => {
  const nodes = Object.keys(SHAPE_NAMES).map(shape => node(shape, { shape, label: shape }));
  const initial = snapshot({
    graph: graph(2, { nodes, edges: [] }),
    history: [{ revision: 1, at: 100, graph: graph(1, { nodes: structuredClone(nodes), edges: [] }) }],
  });
  const unchanged = structuredClone(initial);
  const h = await harness(initial);
  try {
    const groups = [...h.$('node-layer').children];
    const paths = groups.map(group => ({
      outline: sketchPaths(sketchGroup(group)),
      details: detailGroup(group) ? sketchPaths(detailGroup(group)) : [],
    }));
    const withDetails = new Set(['cylinder', 'browser', 'queue', 'class_box', 'interface_box', 'document', 'folder']);
    for (const [index, group] of groups.entries()) {
      const item = nodes[index], details = detailGroup(group);
      assert.deepEqual(paths[index].outline, sketchOutline(item.shape, item.id));
      assert.deepEqual(paths[index].details, sketchDetails(item.shape, item.id));
      assert.equal(Boolean(details), withDetails.has(item.shape), `${item.shape} gets only its own detail seams`);
      assert.ok(group.content.children.some(child => child.className === 'node-shape'), 'canonical fills remain');
      const hit = group.children.find(child => child.className === 'node-hit');
      assert.equal(hit.getAttribute('width'), '190');
      assert.equal(hit.getAttribute('height'), '104');
      assert.equal(hit.getAttribute('pointer-events'), 'all');
      assert.equal(group.content.children.filter(child => child.tagName === 'path' && child.className === 'node-detail').length, 0,
        'rough seams do not leave a straight path underneath');
      if (item.shape === 'browser') {
        const dots = group.content.children.filter(child => child.tagName === 'circle' && child.className === 'node-detail');
        assert.deepEqual(dots.map(dot => Number(dot.getAttribute('cx'))), [12, 22, 32]);
      }
      if (item.shape === 'class_box' || item.shape === 'interface_box') {
        assert.equal(group.content.children.find(child => child.className === 'shape-symbol').textContent,
          item.shape === 'class_box' ? 'C' : '«interface»');
      }
      if (details) {
        assert.ok(group.content.children.indexOf(details) < group.content.children.findIndex(child => child.className === 'node-role'));
        for (const element of [details, ...details.children]) {
          assert.equal(element.getAttribute('fill'), 'none');
          assert.equal(element.getAttribute('aria-hidden'), 'true');
          assert.equal(element.getAttribute('pointer-events'), 'none');
        }
      }
    }
    for (const [tone, update] of [
      ['proposed', { classification: 'tentative' }],
      ['stale', { validity: 'stale' }],
    ]) {
      h.send({ ...h.current, graph: { ...h.current.graph, nodes: nodes.map(item => ({ ...item, ...update })) } });
      for (const [index, group] of groups.entries()) {
        assert.equal(group.dataset.tone, tone);
        assert.deepEqual(sketchPaths(sketchGroup(group)), paths[index].outline);
        assert.deepEqual(detailGroup(group) ? sketchPaths(detailGroup(group)) : [], paths[index].details);
      }
    }
    await h.$('replay').fire('click');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    for (const [index, group] of h.$('node-layer').children.entries()) {
      assert.deepEqual(sketchPaths(sketchGroup(group)), paths[index].outline);
      assert.deepEqual(detailGroup(group) ? sketchPaths(detailGroup(group)) : [], paths[index].details);
    }
    assert.deepEqual(initial, unchanged, 'decorations do not alter canonical evidence or shapes');
  } finally { h.close(); }
});

test('rough connections retain canonical hit targets and stable ink across status, focus, repeated snapshots and replay', async () => {
  const base = graph();
  const edges = [
    base.edges[0],
    { ...base.edges[0], id: 'api-call-db', relation: 'calls', label: 'calls' },
    { ...base.edges[0], id: 'db-call-api', source: 'database', target: 'api', relation: 'calls', label: 'calls' },
    { ...base.edges[0], id: 'api-self', target: 'api', relation: 'calls', label: 'calls itself' },
  ];
  const h = await harness(snapshot({
    graph: graph(2, { edges }),
    history: [{ revision: 1, at: 100, graph: graph(1, { edges: structuredClone(edges) }) }],
  }));
  try {
    const groups = [...h.$('edge-layer').children];
    const paths = groups.map(connectionPaths);
    for (const [index, group] of groups.entries()) {
      assertConnectionGeometry(h, group, edges[index].id);
      assert.equal(group.line.className, 'edge-line', 'the primary stroke keeps its established class');
      assert.equal(group.hit.getAttribute('pointer-events'), 'stroke');
      for (const ink of [group.line, group.secondaryLine, ...group.heads]) {
        assert.ok(ink.getAttribute('d').length > 0);
        assert.equal(ink.getAttribute('fill'), 'none');
        assert.equal(ink.getAttribute('pointer-events'), 'none');
        assert.equal(ink.getAttribute('aria-hidden'), 'true');
        assert.equal(ink.getAttribute('marker-end'), null, 'open paths replace solid marker triangles');
      }
      await group.control.fire('keydown', { key: 'Enter' });
      assert.equal(group.dataset.selected, 'true');
      await group.control.fire('focus');
      assert.equal(group.classList.contains('is-focused'), true);
      await group.control.fire('blur');
      assert.equal(group.classList.contains('is-focused'), false);
    }
    for (const update of [{}, { classification: 'tentative' }, { validity: 'stale' }]) {
      h.send({ ...h.current, graph: { ...h.current.graph, edges: edges.map(edge => ({ ...edge, ...update })) } });
      assert.deepEqual(h.$('edge-layer').children, groups);
      assert.deepEqual(groups.map(connectionPaths), paths);
      assert.equal(groups.at(-1).dataset.selected, 'true', 'status updates preserve keyboard selection');
      assert.equal(groups[0].dataset.tone, update.validity ? 'stale' : update.classification ? 'proposed' : 'observed');
    }
    h.send({ ...h.current, graph: { ...h.current.graph, edges: [...h.current.graph.edges].reverse() } });
    assert.deepEqual(groups.map(connectionPaths), paths, 'edge list order does not change identity seeds');
    await h.$('replay').fire('click');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    assert.deepEqual(h.$('edge-layer').children.map(connectionPaths), paths);
    await h.$('live').fire('click');
    assert.deepEqual(h.$('edge-layer').children.map(connectionPaths), paths);
  } finally { h.close(); }
});

test('themes remain scoped to bounded project/session/live and individual replay views', async () => {
  const h = await harness();
  const choose = async theme => { h.$('theme').value = theme; await h.$('theme').fire('change'); };
  try {
    await choose('ocean');
    await h.$('replay').fire('click');
    assert.equal(h.$('theme').value, 'sketchbook');
    await choose('berry');
    const privacyUpdate = structuredClone(h.current);
    for (const frame of privacyUpdate.history) for (const item of frame.graph.nodes) {
      for (const ref of item.sourceRefs) delete ref.excerpt;
    }
    h.send(privacyUpdate);
    assert.equal(h.$('theme').value, 'berry');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    await h.$('live').fire('click');
    assert.equal(h.$('theme').value, 'ocean');
    await h.$('replay').fire('click');
    assert.equal(h.$('theme').value, 'berry');
    await h.$('live').fire('click');
    h.send({ ...h.current, sessionId: 'session-2' });
    assert.equal(h.$('theme').value, 'sketchbook');
    await choose('forest');
    h.send({ ...h.current, sessionId: 'session-1' });
    assert.equal(h.$('theme').value, 'ocean');
    h.send({ ...h.current, projectId: 'project-2' });
    assert.equal(h.$('theme').value, 'sketchbook');
    h.send({ ...h.current, projectId: 'project-1' });
    assert.equal(h.$('theme').value, 'ocean');
    for (let index = 0; index < 33; index++) h.send({ ...h.current, sessionId: `session-shelf-${index}` });
    h.send({ ...h.current, sessionId: 'session-1' });
    assert.equal(h.$('theme').value, 'sketchbook', 'old preferences are evicted with the 32-view memory bound');
  } finally { h.close(); }
});

test('changing themes preserves balloon deadlines and identical inert burst outlines, including movement in progress', async () => {
  const h = await harness();
  try {
    h.send(h.current);
    h.send(changed(h, [...h.current.graph.nodes, node('arrival', { label: 'Arrival', kind: 'class', shape: 'class_box' })], h.current.graph.edges));
    const arrival = nodeGroup(h, 'Arrival');
    const outline = sketchGroup(arrival), paths = sketchPaths(outline);
    const detailPaths = sketchPaths(detailGroup(arrival));
    h.advance(200);
    h.$('theme').value = 'midnight';
    await h.$('theme').fire('change');
    assert.equal(sketchGroup(arrival), outline);
    assert.ok(arrival.visual.classList.contains('is-appearing'));
    h.advance(281);
    assert.equal(appearing(h).length, 0, 'the original arrival deadline is unchanged');
    h.send(changed(h, h.current.graph.nodes.filter(item => item.id !== 'arrival'), h.current.graph.edges));
    const burst = h.$('effects-layer').children[0];
    const burstContent = burst.children[0].children[0];
    const burstSketch = burstContent.children.find(child => child.className === 'node-sketch');
    assert.deepEqual(sketchPaths(burstSketch), paths, 'a removed node uses the same shape and identity');
    assert.deepEqual(sketchPaths(burstContent.children.find(child => child.classList.contains('node-sketch-details'))), detailPaths,
      'removal details use the same cached identity as the live shape');
    assert.equal(burst.dataset.kind, 'class');
    assert.equal(burstSketch.getAttribute('fill'), 'none');
    assert.equal(burst.getAttribute('pointer-events'), 'none');
    h.advance(200);
    h.$('theme').value = 'sunset';
    await h.$('theme').fire('change');
    assert.equal(h.$('effects-layer').children[0], burst);
    h.advance(181);
    assert.equal(h.$('effects-layer').children.length, 0, 'the original removal deadline is unchanged');
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    assert.equal(h.frames.size, 1);
    h.frame(0);
    h.frame(125);
    const during = positions(h), animation = [...h.frames.keys()];
    h.$('theme').value = 'forest';
    await h.$('theme').fire('change');
    assert.deepEqual(positions(h), during);
    assert.deepEqual([...h.frames.keys()], animation);
    h.frame(250);
    assert.equal(h.frames.size, 0);
    assert.notDeepEqual(positions(h), during);
  } finally { h.close(); }
});

test('live balloon effects require a stream baseline, remove canonical hit targets immediately, and cancel on rapid re-add', async () => {
  const h = await harness();
  try {
    assert.equal(appearing(h).length, 0, 'initial HTTP hydration is not an arrival');
    h.send(changed(h, [...h.current.graph.nodes, node('first-sse', { label: 'First SSE' })]));
    assert.equal(appearing(h).length, 0, 'first complete SSE snapshot is a baseline');
    h.send(changed(h, [...h.current.graph.nodes, node('arrival', { label: 'Arrival', kind: 'class', shape: 'class_box' })]));
    const arrival = nodeGroup(h, 'Arrival');
    assert.ok(arrival.visual.classList.contains('is-appearing'));
    assert.equal(arrival.getAttribute('transform').startsWith('translate('), true);
    assert.equal(arrival.children.find(child => child.className === 'node-hit').getAttribute('width'), '190');
    assert.equal(arrival.visual.getAttribute('transform'), null, 'CSS scale belongs to the nested visual, not position transform');
    await arrival.fire('click');
    assert.match(h.$('inspector-body').textContent, /Arrival/);
    assert.match(h.$('inspector-body').textContent, /Class component/);
    const stale = structuredClone(h.current);
    stale.graph.nodes.at(-1).validity = 'stale';
    h.send(stale);
    assert.equal(h.$('effects-layer').children.length, 0, 'stale styling does not pop a node');

    h.send(changed(h, h.current.graph.nodes.filter(item => item.id !== 'arrival')));
    assert.equal(nodeGroup(h, 'Arrival'), undefined);
    assert.match(h.$('inspector-body').textContent, /Selection left this revision/);
    assert.equal(h.$('graph-count').textContent, '3 components · 0 relationships');
    assert.equal(h.$('effects-layer').children.length, 1);
    const burst = h.$('effects-layer').children[0];
    assert.equal(burst.getAttribute('pointer-events'), 'none');
    assert.equal(burst.getAttribute('aria-hidden'), 'true');
    assert.equal(burst.querySelector('[role="button"]'), null);
    assert.doesNotMatch(burst.textContent, /Arrival|Code evidence/, 'no stale title/evidence is kept in the decoration');
    assert.equal(burst.children.length, 9, 'one outline and eight bounded particles');

    h.send(changed(h, [...h.current.graph.nodes, node('arrival', { label: 'Arrival' })]));
    assert.equal(h.$('effects-layer').children.length, 0, 'same-ID re-add removes its old pop immediately');
    assert.equal(appearing(h).length, 1);
    h.advance(500);
    assert.equal(appearing(h).length, 0, 'timer fallback cleans up even without CSS animationend');
    assert.equal(nodeGroup(h, 'Arrival').getAttribute('aria-pressed'), 'true', 'selection follows canonical identity through a re-add');
  } finally { h.close(); }
});

test('motion is capped and cancelled for hidden tabs, reduced motion, reconnect, replay, session switches and teardown', async () => {
  const h = await harness();
  try {
    h.send(h.current);
    h.send(changed(h, [...h.current.graph.nodes,
      ...Array.from({ length: 40 }, (_, index) => node(`new-${index}`, { label: `New ${index}` }))]));
    assert.equal(appearing(h).length, 16);
    h.send(changed(h, []));
    assert.ok(h.$('effects-layer').children.length <= 16);
    h.hide(true);
    assert.equal(h.$('effects-layer').children.length, 0);
    h.send(changed(h, [node('hidden', { label: 'Hidden' })]));
    assert.equal(appearing(h).length, 0);
    h.hide(false);
    h.send(changed(h, [node('visible', { label: 'Visible' })]));
    assert.equal(appearing(h).length, 0, 'returning to a visible tab starts a fresh baseline');
    h.send(changed(h, [node('visible'), node('motion')]));
    assert.equal(appearing(h).length, 1);
    h.media.change(true);
    assert.equal(appearing(h).length, 0);
    h.send(changed(h, [node('reduced')]));
    assert.equal(h.$('effects-layer').children.length, 0);
    assert.equal(appearing(h).length, 0);
    h.media.change(false);
    h.send(changed(h, [node('after-reduced')]));
    assert.equal(appearing(h).length, 0, 'reduced-motion changes do not fabricate missed arrivals');
    h.streams[0].emit('error');
    h.send(changed(h, [node('reconnected')]));
    assert.equal(appearing(h).length, 0, 'reconnect snapshot is a fresh baseline');
    await h.$('replay').fire('click');
    assert.equal(appearing(h).length, 0);
    h.send(changed(h, [node('during-replay')]));
    assert.equal(appearing(h).length, 0);
    assert.equal(h.$('effects-layer').children.length, 0);
    await h.$('live').fire('click');
    h.send(changed(h, [node('return-live')]));
    assert.equal(appearing(h).length, 0, 'return from replay starts a fresh baseline');
    h.send({ ...changed(h, [node('another-session')]), sessionId: 'session-2' });
    assert.equal(appearing(h).length, 0);
    assert.equal(h.$('effects-layer').children.length, 0);
    h.send(changed(h, [node('session-addition')]));
    assert.equal(appearing(h).length, 1);
    h.windowEvent('pagehide');
    assert.equal(appearing(h).length, 0);
    assert.equal(h.streams[0].closed, true);
  } finally { h.close(); }
});

test('Arrange animates nodes, rough shafts, arrowheads, canonical hit paths and labels together; interruption settles immediately', async () => {
  const h = await harness();
  try {
    const nodes = [...h.$('node-layer').children];
    const edge = h.$('edge-layer').children[0];
    const id = h.current.graph.edges[0].id;
    const beforeInk = connectionPaths(edge);
    await edge.control.fire('click');
    const before = positions(h);
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    assert.equal(h.frames.size, 1);
    assert.deepEqual(positions(h), before, 'motion begins from the previous positions');
    assert.deepEqual(connectionPaths(edge), beforeInk, 'the first frame restores the starting ink and heads');
    h.frame(0);
    h.frame(125);
    const during = positions(h);
    assert.notDeepEqual(during, before);
    assertConnectionGeometry(h, edge, id);
    assert.notDeepEqual(connectionPaths(edge).heads, beforeInk.heads, 'heads move and turn during interpolation');
    assert.deepEqual([...h.$('node-layer').children], nodes);
    assert.equal(edge.control.getAttribute('aria-pressed'), 'true');
    assert.match(h.$('inspector-body').textContent, /Writes relationship/);
    h.frame(250);
    assert.equal(h.frames.size, 0);
    assert.deepEqual(positions(h), [{ x: 0, y: 0 }, { x: 270, y: 0 }]);
    assertConnectionGeometry(h, edge, id);
    h.$('layout').value = 'circular';
    await h.$('layout').fire('change');
    assert.equal(h.frames.size, 1);
    h.hide(true);
    assert.equal(h.frames.size, 0, 'visibility change settles positions and cancels frame callbacks');
    assertConnectionGeometry(h, edge, id);
    const settled = positions(h);
    h.advance(1000);
    assert.deepEqual(positions(h), settled, 'stale fallback cannot move the graph later');
    h.hide(false);
    h.$('layout').value = 'hierarchy';
    await h.$('layout').fire('change');
    h.advance(500);
    assert.equal(h.frames.size, 0, 'timer fallback settles a suspended animation');
    assert.deepEqual(positions(h), [{ x: 0, y: 0 }, { x: 0, y: 184 }]);
    assertConnectionGeometry(h, edge, id);
    assert.deepEqual(connectionPaths(edge), beforeInk, 'returning to the same layout redraws identical ink and heads');
    h.media.change(true);
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    assert.equal(h.frames.size, 0, 'reduced motion applies the final geometry immediately');
    assertConnectionGeometry(h, edge, id);
  } finally { h.close(); }
});

test('shape overrides and arrangements stay in their session/live/replay scopes while evidence privacy reprojection remains authoritative', async () => {
  const h = await harness();
  try {
    const liveApi = nodeGroup(h, 'Notes API');
    await liveApi.fire('click');
    assert.equal(liveApi.dataset.shape, 'rounded_rect', 'valid legacy shape survives initial display');
    let select = h.$('display-shape');
    assert.equal(select.children.length, 16, 'Automatic plus the fifteen named finite shapes');
    assert.match(h.$('inspector-body').textContent, /Shape · visual only/);
    select.value = 'folder';
    select.focus();
    await select.fire('change');
    assert.equal(liveApi.dataset.shape, 'folder');
    assert.match(liveApi.getAttribute('aria-label'), /\. Service\./);
    h.send(h.current);
    assert.equal(h.$('display-shape'), select, 'a metadata snapshot preserves the focused override control');
    assert.equal(h.document.activeElement, select);
    h.$('auto-arrange').checked = false;
    await h.$('auto-arrange').fire('change');
    h.$('layout').value = 'original';
    await h.$('layout').fire('change');
    h.advance(500);
    assert.deepEqual(positions(h), [{ x: 50, y: 80 }, { x: 380, y: 80 }]);
    await h.$('replay').fire('click');
    assert.equal(h.$('auto-arrange').checked, true);
    assert.equal(h.$('layout').value, 'hierarchy');
    assert.equal(liveApi.dataset.shape, 'rounded_rect', 'replay does not inherit the live override');
    select = h.$('display-shape');
    select.value = 'hexagon';
    await select.fire('change');
    const privateSnapshot = structuredClone(h.current);
    for (const historical of privateSnapshot.history) for (const item of historical.graph.nodes) {
      for (const ref of item.sourceRefs) delete ref.excerpt;
    }
    h.send(privateSnapshot);
    assert.equal(liveApi.dataset.shape, 'hexagon');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    assert.doesNotMatch(h.$('inspector-body').textContent, /database.save/);
    await h.$('live').fire('click');
    assert.equal(liveApi.dataset.shape, 'folder');
    assert.equal(h.$('auto-arrange').checked, false);
    assert.equal(h.$('layout').value, 'original');
    select = h.$('display-shape');
    select.value = 'automatic';
    await select.fire('change');
    assert.equal(liveApi.dataset.shape, 'component', 'explicit Automatic opts into the new role mapping');
    assert.equal(h.current.graph.nodes[0].shape, 'rounded_rect', 'the underlying record remains unchanged');
    h.send({ ...h.current, sessionId: 'session-2' });
    assert.equal(nodeGroup(h, 'Notes API').dataset.shape, 'rounded_rect');
    h.send({ ...h.current, sessionId: 'session-1' });
    assert.equal(nodeGroup(h, 'Notes API').dataset.shape, 'component', 'returning to a session restores its bounded in-memory override');
    assert.equal(h.$('layout').value, 'original');
    assert.equal(h.requests.some(request => !['/api/state', '/api/connection-info', '/api/about'].includes(request.url)), false, 'presentation controls never write to the service');
  } finally { h.close(); }
});

test('explicit layout changes reframe an offscreen graph without animating it back out of view', async () => {
  const initial = snapshot({ graph: graph(2, { nodes: [node('far', { x: 10000, y: 10000 })], edges: [] }) });
  const unchanged = structuredClone(initial);
  const h = await harness(initial);
  try {
    const canvas = h.$('architecture');
    const initialView = canvas.getAttribute('viewBox');
    const selected = h.$('node-layer').children[0];
    await selected.fire('click');
    h.$('layout').value = 'original';
    await h.$('layout').fire('change');
    assert.deepEqual(positions(h), [{ x: 10000, y: 10000 }]);
    assertGraphFits(h);
    assert.equal(h.frames.size, 0, 'a reframe presents the final geometry immediately');
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    h.$('layout').value = 'hierarchy';
    await h.$('layout').fire('change');
    assert.deepEqual(positions(h), [{ x: 0, y: 0 }]);
    assert.equal(canvas.getAttribute('viewBox'), initialView);
    assert.equal(h.frames.size, 0);
    assert.deepEqual(initial, unchanged, 'layout and camera changes never edit canonical data');
  } finally { h.close(); }
});

test('layout and Arrange refit the complete graph while status updates preserve manual zoom and pan', async () => {
  const h = await harness();
  try {
    const canvas = h.$('architecture');
    const unchanged = structuredClone(h.current.graph);
    const selected = h.$('node-layer').children[0];
    await selected.fire('click');
    await h.$('zoom-in').fire('click');
    await canvas.fire('keydown', { key: 'ArrowRight' });
    const usefulView = canvas.getAttribute('viewBox');
    h.send({ ...h.current, status: { ...h.current.status, pending: 2 } });
    assert.equal(canvas.getAttribute('viewBox'), usefulView, 'status updates retain the manual camera');
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    assert.notEqual(canvas.getAttribute('viewBox'), usefulView, 'layout selection fits before movement');
    assert.equal(h.frames.size, 1, 'the nearby layout still animates');
    h.advance(500);
    assertGraphFits(h);
    const fittedView = canvas.getAttribute('viewBox');
    const fittedZoom = h.$('zoom-level').textContent;
    await h.$('arrange').fire('click');
    assert.equal(canvas.getAttribute('viewBox'), fittedView);
    await h.$('zoom-in').fire('click');
    for (let step = 0; step < 40; step++) await canvas.fire('keydown', { key: 'ArrowRight' });
    const offscreenView = canvas.getAttribute('viewBox');
    h.send({ ...h.current, activity: [] });
    assert.equal(canvas.getAttribute('viewBox'), offscreenView, 'ordinary snapshots preserve the chosen camera');
    await h.$('arrange').fire('click');
    assert.notEqual(canvas.getAttribute('viewBox'), offscreenView);
    assert.equal(canvas.getAttribute('viewBox'), fittedView);
    assert.equal(h.$('zoom-level').textContent, fittedZoom);
    assertGraphFits(h);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.current.graph, unchanged, 'fitting never changes canonical evidence or positions');
  } finally { h.close(); }
});

test('Arrange fully fits a graph that is only partly visible after manual panning', async () => {
  const h = await harness(snapshot({ graph: graph(2, { nodes: [node()], edges: [] }) }));
  try {
    const canvas = h.$('architecture');
    await h.$('zoom-in').fire('click');
    for (let step = 0; step < 3; step++) await canvas.fire('keydown', { key: 'ArrowRight' });
    const partial = viewport(h);
    const point = positions(h)[0];
    assert.ok(partial.x > point.x && partial.x < point.x + 190,
      'the manual camera clips part of the node but still shows the rest');
    h.send({ ...h.current, activity: [] });
    assert.deepEqual(viewport(h), partial, 'a repeated graph preserves that manual choice');
    await h.$('arrange').fire('click');
    assert.notDeepEqual(viewport(h), partial);
    assertGraphFits(h);
    assert.equal(h.frames.size, 0, 'fitting unchanged positions does not invent layout movement');
  } finally { h.close(); }
});

test('presentation switches and teardown release pointer capture and reject the old drag', async () => {
  const h = await harness();
  try {
    const canvas = h.$('architecture');
    const transitions = [
      () => h.send({ ...h.current, sessionId: 'session-2' }),
      () => h.$('replay').fire('click'),
      () => h.$('live').fire('click'),
      () => h.send({ ...h.current, projectId: 'project-2' }),
      () => {
        h.$('layout').value = 'dependency';
        return h.$('layout').fire('change');
      },
      () => h.$('fit').fire('click'),
      () => h.stop(),
    ];
    let pointerId = 0;
    for (const transition of transitions) {
      pointerId++;
      await h.$('zoom-in').fire('click');
      await canvas.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId });
      assert.ok(h.capturedPointers.has(pointerId));
      await transition();
      assert.equal(h.capturedPointers.size, 0);
      assert.equal(h.releasedPointers.at(-1), pointerId);
      assert.equal(canvas.classList.contains('is-panning'), false);
      const settledView = canvas.getAttribute('viewBox');
      await canvas.fire('pointermove', { clientX: 500, clientY: 500, pointerId });
      assert.equal(canvas.getAttribute('viewBox'), settledView, 'old coordinates cannot overwrite the new camera');
    }
    await canvas.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 99 });
    assert.equal(h.capturedPointers.size, 0, 'a closed viewer cannot start another drag');
  } finally { h.close(); }
});

test('every shape clips title overflow independently of fonts while preserving the full accessible label', async () => {
  const label = 'W'.repeat(60) + '類'.repeat(30);
  const h = await harness(snapshot({ graph: graph(2, {
    nodes: Object.keys(SHAPE_NAMES).map(shape => node(shape, { shape, label })), edges: [],
  }) }));
  try {
    for (const group of h.$('node-layer').children) {
      const viewport = group.content.children.find(child => child.getAttribute('class') === 'node-title-viewport');
      assert.ok(viewport, `${group.dataset.shape} needs a bounded title viewport`);
      assert.equal(viewport.tagName, 'svg');
      assert.equal(viewport.getAttribute('overflow'), 'hidden');
      assert.equal(viewport.getAttribute('pointer-events'), 'none');
      const x = Number(viewport.getAttribute('x'));
      const width = Number(viewport.getAttribute('width'));
      assert.ok(x >= 16 && x + width <= 174);
      if (group.dataset.shape === 'queue') assert.ok(x > 17 && x + width < 173);
      if (group.dataset.shape === 'diamond') {
        const y = Number(viewport.getAttribute('y'));
        const height = Number(viewport.getAttribute('height'));
        for (const px of [x, x + width]) for (const py of [y, y + height]) {
          assert.ok(Math.abs(px - 95) / 109 + Math.abs(py - 52) / 64 < 1);
        }
      }
      assert.equal(group.querySelector('title').textContent, label);
      assert.ok(group.getAttribute('aria-label').startsWith(`${label}.`));
      await group.fire('click');
      assert.ok(h.$('inspector-body').textContent.includes(label));
    }
  } finally { h.close(); }
});
