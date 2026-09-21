import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  startViewer, fitViewport, graphBounds, normalizeGraph, normalizeSnapshot,
  createPresentation, projectPresentation, sanitizedExport,
} from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, node, activity } from './fixtures.mjs';

function chain(length, revision = 1) {
  return graph(revision, {
    nodes: Array.from({ length }, (_, index) => node(`node-${index}`, {
      label: `Component ${index}`, kind: 'service', shape: 'component',
    })),
    edges: Array.from({ length: Math.max(0, length - 1) }, (_, index) => ({
      ...graph().edges[0], id: `edge-${index}`,
      source: `node-${index}`, target: `node-${index + 1}`,
    })),
  });
}

function presented(value, algorithm = 'hierarchy') {
  const view = createPresentation();
  view.algorithm = algorithm;
  return projectPresentation(normalizeGraph(value), view);
}

function contains(viewport, bounds, message = 'all diagram bounds are visible') {
  const epsilon = 1e-7;
  assert.ok(
    viewport.x <= bounds.x + epsilon && viewport.y <= bounds.y + epsilon &&
    viewport.x + viewport.width >= bounds.x + bounds.width - epsilon &&
    viewport.y + viewport.height >= bounds.y + bounds.height - epsilon,
    `${message}: ${JSON.stringify({ viewport, bounds })}`,
  );
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function assertBurstsVisible(h, effects = h.$('effects-layer').children) {
  for (const effect of effects) {
    const [x, y] = effect.getAttribute('transform').match(/[-\d.]+/g).map(Number);
    contains(h.viewport(), { x: x - 128, y: y - 110, width: 256, height: 220 },
      'the pop outline and travelling particles remain in the viewport');
  }
}

async function harness(initial = snapshot(), size = { width: 920, height: 510 }) {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id);
  let dimensions = { ...size }, current = initial, nextId = 0, now = 0;
  const streams = [], timers = new Map(), frames = new Map(), observers = [], listeners = new Map();
  const keys = ['document', 'window', 'fetch', 'EventSource', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const canvas = $('architecture');
  let wheelOptions;
  const addCanvasListener = canvas.addEventListener.bind(canvas);
  canvas.addEventListener = (type, callback, options) => {
    if (type === 'wheel') wheelOptions = options;
    addCanvasListener(type, callback, options);
  };
  canvas.getBoundingClientRect = () => ({ left: 120, top: 80, ...dimensions });
  $('diagram-stage').getBoundingClientRect = () => ({ ...dimensions });
  canvas.closest = () => null;
  const pointers = new Set();
  canvas.setPointerCapture = id => pointers.add(id);
  canvas.hasPointerCapture = id => pointers.has(id);
  canvas.releasePointerCapture = id => pointers.delete(id);
  const media = {
    matches: false,
    listener: null,
    addEventListener(_type, listener) { this.listener = listener; },
    removeEventListener() { this.listener = null; },
    change(matches) { this.matches = matches; this.listener?.(); },
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  class EventSource {
    constructor() { this.listeners = new Map(); streams.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() { this.closed = true; }
  }
  globalThis.document = document;
  globalThis.window = {
    location: { hash: '', pathname: '/', search: '' }, history: {},
    ResizeObserver, matchMedia: () => media,
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  globalThis.EventSource = EventSource;
  globalThis.setTimeout = (callback, duration = 0) => { const id = ++nextId; timers.set(id, { callback, at: now + duration }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.fetch = async url => {
    if (url === '/api/connection-info') return new Response(JSON.stringify({ projectRoot: '/fixture/Notes project', instructions: [] }));
    assert.equal(url, '/api/state');
    return new Response(JSON.stringify(current));
  };
  const viewer = startViewer();
  try {
    await viewer.ready;
    streams[0].emit('open');
  } catch (error) {
    viewer.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    throw error;
  }
  return {
    $, media, frames, streams, observers, pointers, listeners, wheelOptions,
    get current() { return current; },
    get dimensions() { return dimensions; },
    viewport() {
      const [x, y, width, height] = canvas.getAttribute('viewBox').split(' ').map(Number);
      return { x, y, width, height };
    },
    send(value) { current = value; streams.at(-1).emit('snapshot', JSON.stringify(value)); },
    advance(duration) {
      now += duration;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
    resize(width, height) {
      dimensions = { width, height };
      observers[0].callback();
      listeners.get('resize')?.();
    },
    frame(timestamp) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(timestamp);
    },
    close() {
      try {
        viewer.close();
        assert.equal(frames.size, 0);
        assert.equal(timers.size, 0);
        assert.ok(observers.every(observer => observer.disconnected));
        assert.equal(listeners.has('resize'), false);
        assert.equal(canvas.listeners.get('wheel')?.length, 0);
      } finally {
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    },
  };
}

async function wheel(h, properties = {}, target = h.$('architecture')) {
  let prevented = false;
  await target.fire('wheel', {
    deltaY: -60, deltaX: 0, deltaMode: 0, clientX: 350, clientY: 200,
    ...properties, preventDefault() { prevented = true; },
  });
  return prevented;
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)),
    `${actual} should be close to ${expected}`);
}

function assertFocused(h, node, zoom) {
  const viewport = h.viewport();
  near(h.dimensions.width / viewport.width, zoom);
  near(h.dimensions.height / viewport.height, zoom);
  near(viewport.x + viewport.width / 2, node.x + 190 / 2);
  near(viewport.y + viewport.height / 2, node.y + 104 / 2);
  contains(viewport, { x: node.x, y: node.y, width: 190, height: 104 }, 'newest node is visible');
}

test('diagram wheel zooms up/in and down/out around the cursor, including bubbling from a shape', async () => {
  const h = await harness();
  try {
    const canvas = h.$('architecture');
    assert.deepEqual(h.wheelOptions, { passive: false });
    // The fixture only parses IDs; wire up the actual SVG ancestry for bubbling.
    canvas.append(h.$('node-layer'));
    const before = h.viewport();
    const anchor = { x: .25, y: 120 / 510 };
    const point = { x: before.x + before.width * anchor.x, y: before.y + before.height * anchor.y };
    assert.equal(await wheel(h, {}, h.$('node-layer').children[0]), true);
    const after = h.viewport();
    assert.ok(after.width < before.width);
    near(after.x + after.width * anchor.x, point.x);
    near(after.y + after.height * anchor.y, point.y);
    assert.equal(await wheel(h, { deltaY: 60 }), true);
    for (const key of ['x', 'y', 'width', 'height']) near(h.viewport()[key], before[key]);
    await wheel(h);
    const manual = h.viewport();
    h.send({ ...h.current, status: { ...h.current.status, pending: 4 } });
    assert.deepEqual(h.viewport(), manual);
    await h.$('fit').fire('click');
    assert.deepEqual(h.viewport(), before);
  } finally { h.close(); }
});

test('wheel normalizes line/page units, preserves fractional trackpad deltas and caps large events', async () => {
  const h = await harness();
  try {
    const initial = h.viewport();
    for (const [properties, pixels] of [
      [{ deltaY: -.25 }, -.25],
      [{ deltaY: -2, deltaMode: 1 }, -32],
      [{ deltaY: -.1, deltaMode: 2 }, -51],
      [{ deltaY: -10000 }, -100],
      [{ deltaY: -.5, ctrlKey: true }, -.5],
    ]) {
      await h.$('fit').fire('click');
      assert.equal(await wheel(h, properties), true);
      near(h.viewport().width, initial.width * Math.exp(pixels * .002));
    }
  } finally { h.close(); }
});

test('wheel accounts for SVG letterboxing and keeps button/keyboard zoom centered and pan available', async () => {
  const h = await harness();
  try {
    const canvas = h.$('architecture');
    const before = h.viewport();
    canvas.getBoundingClientRect = () => ({ left: 120, top: 80, width: 1000, height: 510 });
    const anchor = { x: (350 - 120 - 40) / 920, y: 120 / 510 };
    await wheel(h);
    near(h.viewport().x + h.viewport().width * anchor.x, before.x + before.width * anchor.x);
    near(h.viewport().y + h.viewport().height * anchor.y, before.y + before.height * anchor.y);
    for (const [target, type, properties, factor] of [
      [h.$('zoom-in'), 'click', {}, 1.25],
      [canvas, 'keydown', { key: '-' }, .8],
    ]) {
      const old = h.viewport();
      await target.fire(type, properties);
      near(h.viewport().width, old.width / factor);
      near(h.viewport().x + h.viewport().width / 2, old.x + old.width / 2);
      near(h.viewport().y + h.viewport().height / 2, old.y + old.height / 2);
    }
    await canvas.fire('pointerdown', { button: 0, pointerId: 1, clientX: 350, clientY: 200 });
    assert.equal(h.pointers.has(1), true);
    const old = h.viewport();
    await canvas.fire('pointermove', { pointerId: 1, clientX: 370, clientY: 220 });
    assert.ok(h.viewport().x < old.x);
    await wheel(h);
    assert.equal(h.pointers.size, 0, 'wheel releases a pan whose camera would otherwise become stale');
    const zoomed = h.viewport();
    await canvas.fire('pointermove', { pointerId: 1, clientX: 390, clientY: 240 });
    assert.deepEqual(h.viewport(), zoomed);
  } finally { h.close(); }
});

test('wheel clamps zoom at both limits without moving the cursor anchor', async () => {
  const h = await harness();
  try {
    for (const [deltaY, limit, button] of [[-10000, 4, 'zoom-in'], [10000, .000001, 'zoom-out']]) {
      const before = h.viewport();
      const point = { x: before.x + before.width * .25, y: before.y + before.height * 120 / 510 };
      for (let i = 0; i < 100; i++) assert.equal(await wheel(h, { deltaY }), true);
      near(h.dimensions.width / h.viewport().width, limit);
      assert.equal(h.$(button).disabled, true);
      near(h.viewport().x + h.viewport().width * .25, point.x);
      near(h.viewport().y + h.viewport().height * 120 / 510, point.y);
      const bounded = h.viewport();
      await wheel(h, { deltaY });
      assert.deepEqual(h.viewport(), bounded);
    }
  } finally { h.close(); }
});

test('wheel leaves off-diagram scrolling, horizontal gestures, empty diagrams and disposed viewers alone', async () => {
  const h = await harness();
  try {
    const before = h.viewport();
    for (const id of ['live-sidebar', 'connection-dialog', 'diagnostics-dialog', 'zoom-in', 'layout', 'diagram-stage']) {
      assert.equal(await wheel(h, {}, h.$(id)), false, id);
    }
    assert.equal(await wheel(h, {}, h.$('architecture').ownerDocument.body), false);
    assert.equal(h.listeners.has('wheel'), false);
    assert.equal(h.$('architecture').ownerDocument.listeners.has('wheel'), false);
    for (const properties of [
      { deltaY: 0 }, { deltaY: NaN }, { deltaY: Infinity }, { deltaY: 1, deltaX: 20 },
      { shiftKey: true }, { defaultPrevented: true },
    ]) assert.equal(await wheel(h, properties), false);
    assert.deepEqual(h.viewport(), before);
  } finally { h.close(); }
  const closed = h.viewport();
  assert.equal(await wheel(h), false);
  assert.deepEqual(h.viewport(), closed);
  const empty = await harness(snapshot({ graph: chain(0) }));
  try {
    const before = empty.viewport();
    assert.equal(await wheel(empty), false);
    assert.deepEqual(empty.viewport(), before);
  } finally { empty.close(); }
});

test('physical viewport fit preserves aspect ratio and shows very tall or wide maps below 50% scale', () => {
  for (const bounds of [
    { x: -200, y: -500, width: 900, height: 18000 },
    { x: -1000, y: 400, width: 25000, height: 300 },
    { x: -1000000, y: -1000000, width: 2000300, height: 2000300 },
  ]) {
    const original = { ...bounds };
    const size = { width: 640, height: 360 };
    const fitted = fitViewport(bounds, size);
    contains(fitted.viewport, bounds);
    assert.ok(fitted.zoom < .5);
    assert.ok(Math.abs(fitted.viewport.width / fitted.viewport.height - size.width / size.height) < 1e-10);
    assert.equal(fitted.zoom, Math.min(size.width / bounds.width, size.height / bounds.height));
    assert.deepEqual(bounds, original);
  }
});

test('an initial long hierarchy fits the real canvas and remains manually zoomable and pannable below 50%', async () => {
  const initial = snapshot({ graph: chain(80) });
  const h = await harness(initial, { width: 640, height: 360 });
  try {
    const bounds = graphBounds(presented(initial.graph));
    contains(h.viewport(), bounds);
    assert.ok(Number.parseFloat(h.$('zoom-level').textContent) < 5);
    assert.equal(h.$('zoom-out').disabled, false);
    const before = h.viewport();
    await h.$('zoom-out').fire('click');
    assert.ok(h.viewport().height > before.height);
    await h.$('architecture').fire('pointerdown', {
      button: 0, pointerId: 1, clientX: 20, clientY: 20,
    });
    assert.ok(h.pointers.has(1), 'pointer panning remains available when a large graph is smaller than 100%');
    await h.$('architecture').fire('pointermove', { pointerId: 1, clientX: 40, clientY: 40 });
    assert.notEqual(h.viewport().x, before.x);
    await h.$('fit').fire('click');
    assert.equal(h.pointers.size, 0);
    contains(h.viewport(), bounds);
  } finally { h.close(); }
});

test('newest shape is centered before insertion and balloon animation, while status, hooks, and activity preserve a manual camera', async () => {
  const h = await harness(snapshot({ graph: chain(3) }), { width: 640, height: 360 });
  try {
    h.send(h.current);
    await h.$('zoom-in').fire('click');
    await h.$('architecture').fire('keydown', { key: 'ArrowDown' });
    const manual = h.viewport();
    const progress = structuredClone(h.current);
    progress.status.pending = 8;
    progress.activity = [activity(2)];
    progress.hookEvents = [{ ...activity(3), receipt: 3 }];
    progress.graph.nodes[0].activityState = 'running';
    h.send(progress);
    h.send(progress);
    assert.deepEqual(h.viewport(), manual);

    const next = { ...progress, graph: chain(40, 2) };
    const newest = presented(next.graph).nodes.at(-1);
    const zoom = Math.max(.5, h.dimensions.width / manual.width);
    const layer = h.$('node-layer');
    const append = layer.append.bind(layer);
    let inserted = 0;
    layer.append = (...items) => {
      assertFocused(h, newest, zoom);
      for (const item of items) {
        assert.ok(item.getAttribute('transform'), 'position is assigned before DOM insertion');
        assert.equal(item.visual.classList.contains('is-appearing'), false, 'camera is set before balloon animation');
      }
      inserted += items.length;
      append(...items);
    };
    h.send(next);
    assert.equal(inserted, 37);
    assert.ok(layer.children.some(group => group.visual.classList.contains('is-appearing')));
    assertFocused(h, newest, zoom);
    const focused = h.viewport();
    h.send({ ...next, status: { ...next.status, pending: 0 } });
    h.advance(1000);
    assert.deepEqual(h.viewport(), focused, 'status and animation cleanup retain arrival focus');
  } finally { h.close(); }
});

test('additions raise a below-50% camera to exactly 50% and preserve both 50% and closer zoom', async () => {
  for (const initialLength of [30, 3]) {
    const h = await harness(snapshot({ graph: chain(initialLength) }));
    try {
      h.send(h.current);
      if (initialLength === 3) await h.$('zoom-in').fire('click');
      const initialZoom = h.dimensions.width / h.viewport().width;
      assert.equal(initialZoom < .5, initialLength === 30);
      for (let count = initialLength + 1; count <= initialLength + 2; count++) {
        h.send({ ...h.current, graph: chain(count, count) });
        assertFocused(h, presented(h.current.graph).nodes.at(-1), Math.max(.5, initialZoom));
        if (initialLength === 30) assert.equal(h.$('zoom-level').textContent, '50%');
      }
    } finally { h.close(); }
  }
});

test('multiple additions select the last new ID in incoming order, even with held layout and existing nodes last', async () => {
  const h = await harness(snapshot({ graph: chain(3) }));
  try {
    h.send(h.current);
    h.$('auto-arrange').checked = false;
    await h.$('auto-arrange').fire('change');
    const before = h.$('node-layer').children.map(group => group.getAttribute('transform'));
    const zoom = Math.max(.5, h.dimensions.width / h.viewport().width);
    const next = graph(2, {
      nodes: [node('z-new'), node('a-new'), ...h.current.graph.nodes],
      edges: h.current.graph.edges,
    });
    const view = createPresentation();
    projectPresentation(normalizeGraph(h.current.graph), view);
    view.auto = false;
    const target = projectPresentation(normalizeGraph(next), view).nodes.find(node => node.id === 'a-new');
    h.send({ ...h.current, graph: next });
    assertFocused(h, target, zoom);
    assert.deepEqual(h.$('node-layer').children.slice(0, 3).map(group => group.getAttribute('transform')), before);
    assert.equal(h.$('node-layer').children.filter(group => group.visual.classList.contains('is-appearing')).length, 2);
    const focused = h.viewport();
    h.send({ ...h.current, graph: { ...next, nodes: [...next.nodes].reverse() } });
    assert.deepEqual(h.viewport(), focused, 'reordering existing IDs is not an addition');
  } finally { h.close(); }
});

test('initial SSE and reconnect baselines fit changed graphs without focusing old additions; identical reconnects keep the camera', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send({ ...h.current, graph: chain(31, 2) });
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
    await h.$('zoom-in').fire('click');
    await h.$('architecture').fire('keydown', { key: 'ArrowDown' });
    const manual = h.viewport();
    h.streams.at(-1).emit('error');
    h.streams.at(-1).emit('open');
    h.send(h.current);
    assert.deepEqual(h.viewport(), manual);
    h.streams.at(-1).emit('error');
    h.streams.at(-1).emit('open');
    h.send({ ...h.current, graph: chain(32, 3) });
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
    assert.equal(h.$('node-layer').children.some(group => group.visual.classList.contains('is-appearing')), false);
    h.send({ ...h.current, graph: chain(33, 4) });
    assertFocused(h, presented(h.current.graph).nodes.at(-1), .5);
    h.send({ ...h.current, sessionId: 'session-2', graph: chain(40, 1) });
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
    const initialSession = h.viewport();
    h.send(h.current);
    h.advance(1000);
    assert.deepEqual(h.viewport(), initialSession);
  } finally { h.close(); }
});

test('reduced motion still focuses actual live additions without a balloon animation', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.media.change(true);
    h.send(h.current);
    h.send({ ...h.current, graph: chain(31, 2) });
    assertFocused(h, presented(h.current.graph).nodes.at(-1), .5);
    assert.equal(h.$('node-layer').children.some(group => group.visual.classList.contains('is-appearing')), false);
  } finally { h.close(); }
});

test('an addition takes priority over simultaneous removals, including their balloon and pop cleanup', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send(h.current);
    const next = chain(3, 2);
    next.nodes.push(node('new-component'));
    const target = presented(next).nodes.at(-1);
    h.send({ ...h.current, graph: next });
    assertFocused(h, target, .5);
    assert.ok(h.$('effects-layer').children.length > 0);
    const focused = h.viewport();
    h.send({ ...h.current, status: { ...h.current.status, calls: 3 } });
    h.advance(1000);
    assert.deepEqual(h.viewport(), focused);
    await h.$('fit').fire('click');
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(next)), h.dimensions).viewport);
  } finally { h.close(); }
});

test('edge-only changes still fit the complete graph after an arrival focus', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send(h.current);
    h.send({ ...h.current, graph: chain(31, 2) });
    assertFocused(h, presented(h.current.graph).nodes.at(-1), .5);
    h.advance(1000);
    h.send({ ...h.current, graph: { ...h.current.graph, revision: 3, edges: [] } });
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
    assert.equal(h.$('node-layer').children.some(group => group.visual.classList.contains('is-appearing')), false);
  } finally { h.close(); }
});

test('arrival during interpolated layout uses final positions and cancels the pending fit without changing closer zoom', async () => {
  for (const completion of ['frames', 'timeout']) {
    const h = await harness(snapshot({ graph: chain(3) }));
    try {
      h.send(h.current);
      h.$('layout').value = 'dependency';
      await h.$('layout').fire('change');
      assert.equal(h.frames.size, 1);
      h.frame(0);
      h.frame(100);
      const displayed = h.$('node-layer').children.map(group => group.getAttribute('transform'));
      const oldTarget = presented(h.current.graph, 'dependency');
      assert.ok(oldTarget.nodes.some((node, index) => displayed[index] !== `translate(${node.x} ${node.y})`));
      const zoom = Math.max(.5, h.dimensions.width / h.viewport().width);
      const next = chain(4, 2);
      const target = presented(next, 'dependency').nodes.at(-1);
      const layer = h.$('node-layer'), append = layer.append.bind(layer);
      layer.append = (...items) => {
        assertFocused(h, target, zoom);
        assert.equal(items[0].getAttribute('transform'), `translate(${target.x} ${target.y})`,
          'the newcomer is inserted at its final layout position');
        append(...items);
      };
      h.send({ ...h.current, graph: next });
      assertFocused(h, target, zoom);
      const focused = h.viewport();
      if (completion === 'frames') { h.frame(200); h.frame(350); }
      h.advance(1000);
      assert.deepEqual(h.viewport(), focused, 'neither interpolation nor fallback timer steals focus');
      assert.equal(h.frames.size, 0);
      await h.$('arrange').fire('click');
      assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(next, 'dependency')), h.dimensions).viewport);
    } finally { h.close(); }
  }
});

test('a shrinking hierarchy shows every removal burst until the last finishes, then fits the remaining graph', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send(h.current);
    const long = h.viewport();
    const layer = h.$('effects-layer');
    const append = layer.append.bind(layer);
    layer.append = (...items) => {
      assertBurstsVisible(h, items);
      append(...items);
    };
    h.send({ ...h.current, graph: chain(3, 2) });
    assert.ok(h.viewport().height < long.height);
    assert.equal(layer.children.length, 16);
    assertBurstsVisible(h);
    const temporary = h.viewport();
    const final = fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport;
    assert.ok(temporary.height > final.height);
    h.send({ ...h.current, status: { ...h.current.status, pending: 3 } });
    assert.deepEqual(h.viewport(), temporary, 'status snapshots retain the transition camera');
    const effects = [...layer.children];
    for (const effect of effects.slice(0, -1)) {
      await effect.fire('animationend');
      assert.deepEqual(h.viewport(), temporary, 'individual completions do not produce repeated zoom steps');
      assertBurstsVisible(h);
    }
    await effects.at(-1).fire('animationend');
    assert.equal(layer.children.length, 0);
    assert.deepEqual(h.viewport(), final);
    const fitted = h.viewport();
    await h.$('zoom-in').fire('click');
    const stale = structuredClone(h.current);
    stale.graph.nodes[0].validity = 'stale';
    h.send(stale);
    assert.deepEqual(h.viewport(), fitted);
    await h.$('zoom-out').fire('click');
    const renamed = structuredClone(h.current);
    renamed.graph.nodes[0].label = 'Renamed component';
    h.send(renamed);
    assert.deepEqual(h.viewport(), fitted);
  } finally { h.close(); }
});

test('manual camera choices during removal survive status snapshots and effect cleanup', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send(h.current);
    h.send({ ...h.current, graph: chain(3, 2) });
    assertBurstsVisible(h);
    await h.$('zoom-in').fire('click');
    await h.$('architecture').fire('keydown', { key: 'ArrowDown' });
    const manual = h.viewport();
    h.send({ ...h.current, status: { ...h.current.status, pending: 4 } });
    assert.deepEqual(h.viewport(), manual);
    h.advance(400);
    assert.equal(h.$('effects-layer').children.length, 0);
    assert.deepEqual(h.viewport(), manual, 'fallback cleanup must not overwrite manual zoom or pan');
    h.send({ ...h.current, graph: chain(4, 3) });
    assertFocused(h, presented(h.current.graph).nodes.at(-1), Math.max(.5, h.dimensions.width / manual.width));
    assert.notDeepEqual(h.viewport(), manual, 'the next actual addition focuses the newcomer');
  } finally { h.close(); }
});

test('resize keeps live bursts visible; a later addition takes focus and burst cleanup cannot steal it', async () => {
  const h = await harness(snapshot({ graph: chain(30) }));
  try {
    h.send(h.current);
    h.send({ ...h.current, graph: chain(3, 2) });
    h.resize(360, 280);
    assertBurstsVisible(h);
    const temporary = h.viewport();
    assert.ok(Math.abs(temporary.width / temporary.height - 360 / 280) < 1e-9);
    h.advance(200);
    h.send({ ...h.current, graph: chain(5, 3) });
    assertFocused(h, presented(h.current.graph).nodes.at(-1), .5);
    const focused = h.viewport();
    h.advance(179);
    assert.equal(h.$('effects-layer').children.length, 14, 'the two re-added identities cancel their old pops');
    h.advance(2);
    assert.equal(h.$('effects-layer').children.length, 0);
    assert.deepEqual(h.viewport(), focused);
  } finally { h.close(); }
});

test('replay, session switches, and reduced motion cancel removal framing without delayed camera changes', async () => {
  for (const action of ['replay', 'session', 'reduced']) {
    const h = await harness(snapshot({ graph: chain(30) }));
    try {
      h.send(h.current);
      h.send({ ...h.current, graph: chain(3, 2) });
      assert.equal(h.$('effects-layer').children.length, 16);
      if (action === 'replay') await h.$('replay').fire('click');
      else if (action === 'session') h.send({ ...h.current, sessionId: 'session-2', graph: chain(2, 1), history: [] });
      else h.media.change(true);
      assert.equal(h.$('effects-layer').children.length, 0);
      const settled = h.viewport();
      h.advance(1000);
      assert.deepEqual(h.viewport(), settled, `${action} cancels every old removal deadline`);
      if (action !== 'replay') {
        assert.deepEqual(settled, fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
      }
    } finally { h.close(); }
  }
});

test('removing the last components delays the empty state until their pops finish', async () => {
  const h = await harness(snapshot({ graph: chain(3) }));
  try {
    h.send(h.current);
    h.send({ ...h.current, graph: chain(0, 2) });
    assert.equal(h.$('node-layer').children.length, 0);
    assert.equal(h.$('effects-layer').children.length, 3);
    assert.equal(h.$('empty-canvas').hidden, true);
    assertBurstsVisible(h);
    h.advance(400);
    assert.equal(h.$('effects-layer').children.length, 0);
    assert.equal(h.$('empty-canvas').hidden, false);
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(presented(h.current.graph)), h.dimensions).viewport);
  } finally { h.close(); }
});

test('layout selection and manual Arrange always fit, including when automatic arrangement is disabled', async () => {
  const h = await harness(snapshot({ graph: chain(5) }));
  try {
    h.$('auto-arrange').checked = false;
    await h.$('auto-arrange').fire('change');
    await h.$('zoom-in').fire('click');
    await h.$('architecture').fire('keydown', { key: 'ArrowRight' });
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    const target = presented(h.current.graph, 'dependency');
    contains(h.viewport(), graphBounds(target), 'target is fitted before layout animation');
    contains(h.viewport(), graphBounds(presented(h.current.graph)), 'the preceding layout remains visible during movement');
    assert.equal(h.frames.size, 1);
    h.frame(0);
    h.frame(250);
    contains(h.viewport(), graphBounds(target));
    assert.deepEqual(h.viewport(), fitViewport(graphBounds(target), h.dimensions).viewport);
    assert.equal(h.$('auto-arrange').checked, false);
    const transforms = h.$('node-layer').children.map(group => group.getAttribute('transform'));
    assert.ok(transforms.every(transform => / 0\)$/.test(transform)), 'dependency selection applies the horizontal layout');

    const fitted = h.viewport();
    await h.$('zoom-in').fire('click');
    for (let i = 0; i < 20; i++) await h.$('architecture').fire('keydown', { key: 'ArrowRight' });
    await h.$('arrange').fire('click');
    assert.deepEqual(h.viewport(), fitted);
  } finally { h.close(); }
});

test('resize preserves manual zoom until explicit Fit; automatic resize and reduced motion still fit', async () => {
  const h = await harness(snapshot({ graph: chain(8) }));
  try {
    await h.$('zoom-in').fire('click');
    const manual = h.viewport();
    h.resize(920, 510);
    assert.deepEqual(h.viewport(), manual, 'repeated observer notifications do not move the manual camera');
    h.resize(400, 280);
    assert.deepEqual(h.viewport(), manual, 'a changed window size must also preserve manual zoom');
    await h.$('fit').fire('click');
    contains(h.viewport(), graphBounds(presented(h.current.graph)));
    assert.ok(Math.abs(h.viewport().width / h.viewport().height - 400 / 280) < 1e-9);
    h.resize(600, 320);
    contains(h.viewport(), graphBounds(presented(h.current.graph)));
    assert.ok(Math.abs(h.viewport().width / h.viewport().height - 600 / 320) < 1e-9);
    h.media.matches = true;
    h.$('layout').value = 'dependency';
    await h.$('layout').fire('change');
    assert.equal(h.frames.size, 0);
    contains(h.viewport(), graphBounds(presented(h.current.graph, 'dependency')));
  } finally { h.close(); }
});

test('new live updates preserve the replay camera; selecting a new session returns to Live and fits it', async () => {
  const h = await harness();
  try {
    await h.$('node-layer').children[0].fire('click');
    await h.$('replay').fire('click');
    await h.$('zoom-in').fire('click');
    const replay = h.viewport();
    h.send({ ...h.current, graph: chain(50, 3) });
    assert.deepEqual(h.viewport(), replay);
    assert.equal(h.$('revision').textContent, 'Revision 1');
    h.send({ ...h.current, sessionId: 'session-2', graph: chain(80, 1), history: [] });
    assert.equal(h.$('live').getAttribute('aria-pressed'), 'true');
    assert.equal(h.$('session').value, 'session-2');
    contains(h.viewport(), graphBounds(presented(h.current.graph)));
    assert.equal(h.$('clear-selection').hidden, true);
  } finally { h.close(); }
});

test('hook receipt normalization is bounded, optional, and contains metadata only', () => {
  assert.equal(normalizeSnapshot(snapshot()).hookEvents, undefined);
  const hookEvents = Array.from({ length: 240 }, (_, index) => ({
    ...activity(index), receipt: index, source: 'private source', thinking: 'private reasoning',
    tool_input: { token: 'private token' }, tool_response: { stdout: 'private contents' },
    label: `Hook ${index}\u0001`,
  }));
  hookEvents[239].receipt = Infinity;
  const raw = snapshot({ hookEvents });
  const normalized = normalizeSnapshot(raw);
  assert.equal(normalized.hookEvents.length, 200);
  assert.equal(normalized.hookEvents[0].receipt, 40);
  assert.equal(normalized.hookEvents.at(-1).receipt, 0);
  assert.equal(normalized.hookEvents.at(-1).label, 'Hook 239');
  assert.equal(normalized.hookEvents[0].at, Date.parse(activity().at));
  const exported = sanitizedExport(raw);
  assert.equal(exported.hookEvents[0].at, new Date(activity().at).toISOString());
  assert.doesNotMatch(JSON.stringify(exported.hookEvents), /private|tool_input|tool_response|thinking/);
});

test('sidebar integration keeps every receipt, opens evidence and replay, and recolors without camera or history changes', async () => {
  const h = await harness(snapshot({
    graph: chain(2, 2),
    history: [{ revision: 1, at: 100, graph: chain(1, 1) }],
    hookEvents: [
      { ...activity(1), id: 'shared-event', kind: 'tool.started', receipt: 1 },
      { ...activity(1), id: 'shared-event', kind: 'tool.succeeded', receipt: 2 },
    ],
  }));
  try {
    assert.deepEqual(h.$('sidebar-hook-list').children.map(row => row.getAttribute('data-receipt')), ['2', '1']);
    const button = label => descendants(h.$('sidebar-change-list')).find(element => element.getAttribute('aria-label') === label);
    await button('Inspect current component Component 1').fire('click');
    assert.match(h.$('inspector-body').textContent, /Component 1/);
    await button('View diagram at revision 1').fire('click');
    assert.equal(h.$('revision').textContent, 'Revision 1');
    assert.match(h.$('sidebar-hook-coverage').textContent, /stays live during replay/);
    await h.$('zoom-in').fire('click');
    const manual = h.viewport();
    const cards = [...h.$('sidebar-change-list').children];
    h.$('theme').value = 'ocean';
    await h.$('theme').fire('change');
    assert.equal(h.$('sidebar-history').dataset.theme, 'ocean');
    assert.deepEqual(h.viewport(), manual);
    assert.deepEqual([...h.$('sidebar-change-list').children], cards);
    await button('Inspect current component Component 1').fire('click');
    assert.equal(h.$('revision').textContent, 'Revision 2', 'a current component opens live evidence while replay is active');
    assert.match(h.$('inspector-body').textContent, /Component 1/);
    const before = [...h.$('sidebar-change-list').children];
    h.send({ ...h.current, status: { ...h.current.status, pending: 1 } });
    assert.deepEqual([...h.$('sidebar-change-list').children], before);
    assert.equal(h.$('sidebar-hook-list').children.length, 2);
  } finally { h.close(); }
});

test('explicit node, arrow, and history inspection scrolls only the sidebar; background snapshots never scroll or steal focus', async () => {
  const h = await harness(snapshot({
    graph: chain(2, 2),
    history: [{ revision: 1, at: 100, graph: chain(1, 1) }],
  }));
  try {
    const container = h.$('live-sidebar');
    const document = container.ownerDocument;
    const panel = document.createElement('section');
    panel.append(h.$('inspector-body'));
    container.append(panel);
    container.scrollTop = 0;
    container.clientTop = 1;
    container.getBoundingClientRect = () => ({ top: 120, height: 400 });
    panel.getBoundingClientRect = () => ({ top: 120 + container.clientTop + 900 - container.scrollTop, height: 600 });
    const calls = [];
    container.scrollTo = options => { calls.push(options); container.scrollTop = options.top; };
    window.scrollTo = () => assert.fail('inspection must never scroll the page');
    panel.scrollIntoView = () => assert.fail('scrollIntoView could also scroll ancestor containers or the page');

    const selected = h.$('node-layer').children[0];
    selected.focus();
    await selected.fire('click');
    assert.deepEqual(calls, [{ top: 900, behavior: 'smooth' }]);
    assert.equal(document.activeElement, selected);
    assert.match(h.$('inspector-body').textContent, /Component 0/);

    container.scrollTop = 150;
    const refreshed = structuredClone(h.current);
    refreshed.status.pending = 1;
    refreshed.graph.nodes[0].validity = 'stale';
    h.send(refreshed);
    assert.equal(calls.length, 1);
    assert.equal(container.scrollTop, 150, 'background evidence changes leave sidebar browsing undisturbed');
    assert.equal(document.activeElement, selected);

    h.media.matches = true;
    const arrow = h.$('edge-label-layer').children[0];
    arrow.focus();
    await arrow.fire('click');
    assert.deepEqual(calls.at(-1), { top: 900, behavior: 'auto' });
    assert.equal(document.activeElement, arrow);
    assert.match(h.$('inspector-body').textContent, /Writes relationship/);

    container.scrollTop = 0;
    const tile = descendants(h.$('sidebar-change-list')).find(element =>
      element.getAttribute('aria-label') === 'Inspect current component Component 1');
    tile.focus();
    await tile.fire('click');
    assert.equal(calls.length, 3);
    assert.equal(container.scrollTop, 900);
    assert.equal(document.activeElement, tile);
    assert.match(h.$('inspector-body').textContent, /Component 1/);
  } finally { h.close(); }
});
