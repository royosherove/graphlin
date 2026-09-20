import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPresentation, projectPresentation, presentationKey, layoutSignature,
  normalizeGraph, displayShape, SHAPE_NAMES, nodeTitleLines, liveNodeChanges, routeEdge,
} from '../../runtime/web/app.js';
import { node, graph, snapshot } from './fixtures.mjs';

test('all twelve roles use the agreed fallback shapes, while all fifteen recorded shapes remain valid', () => {
  const mapping = {
    client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue', external: 'cloud',
    module: 'rect', function: 'hexagon', class: 'class_box', interface: 'interface_box',
    event: 'document', configuration: 'parallelogram', package: 'folder',
  };
  for (const [kind, shape] of Object.entries(mapping)) {
    const normalized = normalizeGraph(graph(1, { nodes: [node(kind, { kind, shape: 'not-safe' })], edges: [] }));
    assert.equal(normalized.nodes[0].kind, kind);
    assert.equal(normalized.nodes[0].shape, shape);
  }
  assert.equal(Object.keys(SHAPE_NAMES).length, 15);
  for (const shape of Object.keys(SHAPE_NAMES)) {
    const recorded = normalizeGraph(graph(1, { nodes: [node('api', { shape })], edges: [] })).nodes[0];
    assert.equal(recorded.shape, shape);
    assert.equal(displayShape(recorded, new Map()), shape);
    assert.equal(displayShape(recorded, new Map([['api', 'automatic']])), 'component');
    assert.equal(recorded.kind, 'service');
  }
});

test('presentation projects only positions/shapes and does not send evidence to the layout engine', () => {
  const input = normalizeGraph(graph());
  const before = structuredClone(input);
  const view = createPresentation();
  let calls = 0;
  const layout = (value, options) => {
    calls++;
    assert.deepEqual(Object.keys(value.nodes[0]).sort(), ['id', 'kind', 'x', 'y']);
    assert.deepEqual(Object.keys(value.edges[0]).sort(), ['id', 'source', 'target']);
    assert.deepEqual(options, { algorithm: 'hierarchy', nodeWidth: 190, nodeHeight: 104, gapX: 80, gapY: 80 });
    return new Map([['api', { x: 12, y: 24 }], ['database', { x: 12, y: 208 }]]);
  };
  view.shapes.set('api', 'folder');
  const projected = projectPresentation(input, view, { layout });
  assert.equal(projected.nodes[0].shape, 'folder');
  assert.equal(projected.nodes[0].kind, 'service');
  assert.deepEqual(projected.nodes[0].sourceRefs, before.nodes[0].sourceRefs);
  assert.equal(projected.nodes[0].x, 12);
  assert.deepEqual(input, before);
  const metadata = structuredClone(input);
  metadata.revision++;
  metadata.nodes[0].label = 'Renamed API';
  metadata.nodes[0].confidence = .1;
  metadata.nodes[0].activityState = 'running';
  metadata.nodes[0].x = 900;
  metadata.nodes.reverse();
  metadata.edges.push({ ...metadata.edges[0], id: 'same-pair', relation: 'calls' });
  projectPresentation(metadata, view, { layout });
  assert.equal(calls, 1, 'metadata, order, canonical movement and parallel labels do not trigger arrangement');
  metadata.nodes[0].kind = 'class';
  projectPresentation(metadata, view, { layout });
  assert.equal(calls, 2, 'a type change triggers arrangement');
  metadata.edges.push({ ...metadata.edges[0], id: 'reverse', source: 'database', target: 'api' });
  projectPresentation(metadata, view, { layout });
  assert.equal(calls, 3, 'a new directed structural pair triggers arrangement');
});

test('auto off preserves surviving positions and stages newcomers without overlap, even beyond the engine limit', () => {
  const view = createPresentation();
  const input = normalizeGraph(graph());
  const first = projectPresentation(input, view);
  view.auto = false;
  const large = normalizeGraph(graph(3, { nodes: [...input.nodes,
    ...Array.from({ length: 300 }, (_, index) => node(`extra-${index}`, { x: 50, y: 80 }))] }));
  const staged = projectPresentation(large, view);
  assert.deepEqual(staged.nodes.slice(0, 2).map(({ x, y }) => [x, y]), first.nodes.map(({ x, y }) => [x, y]));
  const unchanged = projectPresentation(large, view);
  assert.deepEqual(unchanged, staged);
  for (let i = 0; i < staged.nodes.length; i++) for (let j = i + 1; j < staged.nodes.length; j++) {
    const a = staged.nodes[i], b = staged.nodes[j];
    assert.ok(Math.abs(a.x - b.x) >= 190 || Math.abs(a.y - b.y) >= 104, `${a.id} overlaps ${b.id}`);
  }
  view.auto = true;
  const arranged = projectPresentation(large, view, { arrange: true });
  assert.equal(arranged.nodes.length, 302, 'engine admission never removes canonical nodes');
  assert.ok(arranged.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('Original is exact canonical positioning; manual arrangement works with auto off', () => {
  const input = normalizeGraph(graph(1, { nodes: [node('a', { x: -330, y: 401 }), node('b', { x: -330, y: 401 })] }));
  const view = createPresentation();
  projectPresentation(input, view);
  view.auto = false;
  view.algorithm = 'original';
  assert.deepEqual(projectPresentation(input, view).nodes.map(({ x, y }) => [x, y]), [[-330, 401], [-330, 401]]);
  input.nodes[0].x = 440;
  assert.equal(projectPresentation(input, view).nodes[0].x, 440);
  view.algorithm = 'grid';
  const held = projectPresentation(input, view);
  assert.equal(held.nodes[0].x, 440);
  assert.notDeepEqual(projectPresentation(input, view, { arrange: true }).nodes, held.nodes);
});

test('staged nodes near the canonical coordinate limit remain stable on metadata updates', () => {
  const view = createPresentation();
  view.auto = false;
  view.algorithm = 'original';
  const original = normalizeGraph(graph(1, { nodes: [node('edge', { x: 1e6, y: 1e6 })], edges: [] }));
  projectPresentation(original, view);
  view.algorithm = 'grid';
  const next = { ...original, nodes: [...original.nodes, node('new')] };
  const staged = projectPresentation(next, view);
  assert.ok(staged.nodes[1].x > 1e6);
  assert.deepEqual(projectPresentation(next, view), staged);
});

test('presentation keys distinguish project, session, live, and pinned replay revision', () => {
  const current = snapshot();
  const keys = [
    presentationKey(current), presentationKey(current, { revision: 1 }),
    presentationKey(current, { revision: 2 }),
    presentationKey({ ...current, sessionId: 'session-2' }),
    presentationKey({ ...current, projectId: 'project-2' }),
  ];
  assert.equal(new Set(keys).size, 5);
  assert.equal(layoutSignature(current.graph, 'hierarchy'), layoutSignature({ ...current.graph, revision: 100 }, 'hierarchy'));
});

test('titles wrap long declaration names into at most two safe literal lines, including queue gutters', () => {
  const label = 'EnthusiasticGreetingStrategy';
  for (const shape of Object.keys(SHAPE_NAMES)) {
    const lines = nodeTitleLines(label, shape);
    assert.equal(lines.length, 2);
    const visible = lines.join('').replaceAll(' ', '').replace(/…$/, '');
    assert.ok(label.startsWith(visible));
    if (visible !== label) assert.ok(lines[1].endsWith('…'), 'narrow shapes explicitly indicate truncation');
    assert.ok(lines.every(line => line.length > 0));
    assert.ok(nodeTitleLines('W'.repeat(180), shape).at(-1).endsWith('…'));
  }
  assert.match(nodeTitleLines('<script>alert(1)</script>', 'rect').join(''), /<script>/);
});

test('new slanted shapes attach arrows to their actual boundary', () => {
  const source = node('a', { x: 0, y: 0, shape: 'parallelogram' });
  const target = node('b', { x: 400, y: 0, shape: 'parallelogram' });
  const route = routeEdge(source, target);
  assert.equal(route.start.x, 179);
  assert.equal(route.end.x, 411);
  assert.equal(route.start.y, 52);
  const loop = routeEdge(source, source);
  assert.ok(loop.start.x < 190, 'self-loop starts on the slanted edge rather than outside it');
  assert.ok(Number.isFinite(loop.end.x));
});

test('wide Latin, CJK, and emoji labels are conservatively shortened without browser font metrics', () => {
  for (const text of ['W'.repeat(28), '類'.repeat(40), '🙂'.repeat(40)]) {
    const lines = nodeTitleLines(text, 'rect');
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => [...line].length <= 10), 'a 158px text area cannot safely hold fourteen wide glyphs');
    assert.ok(lines[1].endsWith('…'));
    for (const char of lines.join('')) assert.ok(char.codePointAt(0) < 0xd800 || char.codePointAt(0) > 0xdfff);
  }
  assert.ok(nodeTitleLines('W'.repeat(28), 'queue').every(line => [...line].length <= 8));
});

test('diamond ports reach the actual polygon for both directions, parallel lanes, and self references', () => {
  const source = node('a', { x: 0, y: 0, shape: 'diamond' });
  const horizontal = node('b', { x: 400, y: 0, shape: 'diamond' });
  assert.deepEqual(routeEdge(source, horizontal).start, { x: 204, y: 52 });
  assert.deepEqual(routeEdge(source, horizontal).end, { x: 386, y: 52 });
  const onDiamond = (point, item) => {
    const distance = Math.abs(point.x - item.x - 95) / 109 + Math.abs(point.y - item.y - 52) / 64;
    assert.ok(Math.abs(distance - 1) < 1e-9, 'port must lie on the diamond rather than its inner rectangle');
  };
  for (const target of [horizontal, node('b', { x: 0, y: 300, shape: 'diamond' }),
    node('b', { x: -300, y: 200, shape: 'diamond' }), source]) {
    for (const lane of [-6, -1, 0, 1, 6]) {
      const route = routeEdge(source, target, lane);
      onDiamond(route.start, source);
      onDiamond(route.end, target);
      const reverse = routeEdge(target, source, lane);
      onDiamond(reverse.start, target);
      onDiamond(reverse.end, source);
    }
  }
});

test('component ports meet the body and protruding tabs without terminating behind the outline', () => {
  const source = node('a', { x: 0, y: 0, shape: 'component' });
  const target = node('b', { x: 400, y: 0, shape: 'component' });
  assert.deepEqual(routeEdge(source, target).end, { x: 410, y: 52 });
  assert.deepEqual(routeEdge(source, target, 3).end, { x: 400, y: 70 });
  const inside = (x, y) => (x >= 10 && x <= 190 && y >= 0 && y <= 104) ||
    (x >= 0 && x <= 21 && ((y >= 18 && y <= 35) || (y >= 68 && y <= 85)));
  const atOutline = (point, item) => {
    const x = point.x - item.x, y = point.y - item.y;
    const delta = 1e-6;
    assert.ok(inside(95 + (x - 95) * (1 - delta), 52 + (y - 52) * (1 - delta)));
    assert.equal(inside(95 + (x - 95) * (1 + delta), 52 + (y - 52) * (1 + delta)), false);
    // A concave notch can leave and re-enter the body before reaching a tab.
    for (const scale of [1.01, 1.03, 1.06, 1.1, 1.2]) {
      assert.equal(inside(95 + (x - 95) * scale, 52 + (y - 52) * scale), false);
    }
  };
  for (const other of [target, node('b', { x: -400, y: 160, shape: 'component' }), source]) {
    for (const lane of [-6, -3, -1, 0, 1, 3, 6]) {
      for (const [a, b] of [[source, other], [other, source]]) {
        const route = routeEdge(a, b, lane);
        atOutline(route.start, a);
        atOutline(route.end, b);
      }
    }
  }
});

test('live changes compare identity only, never stale styling, and require an eligible baseline', () => {
  const before = graph();
  const stale = graph(2);
  stale.nodes[0].validity = 'stale';
  stale.nodes[0].classification = 'stale';
  assert.deepEqual(liveNodeChanges(before, stale, true), { added: [], removed: [] });
  const next = graph(3, { nodes: [node('database'), node('new')] });
  assert.deepEqual(liveNodeChanges(before, next, true), { added: ['new'], removed: ['api'] });
  assert.deepEqual(liveNodeChanges(before, next, false), { added: [], removed: [] });
});
