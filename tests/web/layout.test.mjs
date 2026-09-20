import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, LAYOUT_ALGORITHMS } from '../../runtime/web/layout.js';

const generated = LAYOUT_ALGORITHMS.filter(value => value !== 'original');
const kinds = ['client', 'service', 'datastore', 'queue', 'external', 'module'];
const id = value => `node-${String(value).padStart(3, '0')}`;
const makeNodes = count => Array.from({ length: count }, (_, i) => ({
  id: id(i), kind: kinds[i % kinds.length], x: (i % 16) * 270, y: Math.floor(i / 16) * 184,
}));
const edge = (source, target) => ({ source, target });
const entries = positions => [...positions];

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function shuffled(values, seed) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assertPositions(positions, count, { nodeWidth = 190, nodeHeight = 104, overlap = false } = {}) {
  assert.equal(positions.size, count);
  const list = [...positions.values()];
  for (const point of list) {
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'each node has finite coordinates');
  }
  if (overlap) return;
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    assert.ok(Math.abs(list[a].x - list[b].x) >= nodeWidth - 1e-7 ||
      Math.abs(list[a].y - list[b].y) >= nodeHeight - 1e-7,
    `node boxes ${a} and ${b} overlap at ${JSON.stringify([list[a], list[b]])}`);
  }
}

function bounds(points, nodeWidth = 190, nodeHeight = 104) {
  return {
    x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x + nodeWidth)),
    bottom: Math.max(...points.map(point => point.y + nodeHeight)),
  };
}

test('empty/malformed inputs are safe; every algorithm returns fresh positions without mutating inputs', () => {
  for (const value of [undefined, null, false, {}, { nodes: null, edges: 'bad' }]) {
    assert.deepEqual(layoutGraph(value), new Map());
  }
  const graph = freeze({ nodes: makeNodes(10), edges: [edge(id(0), id(1)), edge(id(1), id(2))] });
  const before = structuredClone(graph);
  for (const algorithm of LAYOUT_ALGORITHMS) {
    const settings = freeze({ algorithm, nodeWidth: 190, nodeHeight: 104, gapX: 80, gapY: 80 });
    const result = layoutGraph(graph, settings);
    assertPositions(result, 10);
    result.get(id(0)).x = 999999;
    assert.notEqual(layoutGraph(graph, settings).get(id(0)).x, 999999);
  }
  assert.deepEqual(graph, before);
  assert.deepEqual(layoutGraph(graph), layoutGraph(graph, { algorithm: 'hierarchy' }));
  assert.deepEqual(layoutGraph(graph, { algorithm: 'unrecognized' }), layoutGraph(graph));
});

test('directed layouts follow actual edge direction rather than ID order or component kind', () => {
  const graph = {
    nodes: [{ id: 'z', kind: 'datastore' }, { id: 'm', kind: 'client' }, { id: 'a', kind: 'service' }],
    edges: [edge('z', 'm'), edge('m', 'a')],
  };
  for (const algorithm of ['hierarchy', 'dependency']) {
    const result = layoutGraph(graph, { algorithm });
    const axis = algorithm === 'hierarchy' ? 'y' : 'x';
    const minimum = algorithm === 'hierarchy' ? 184 : 270;
    assert.ok(result.get('m')[axis] - result.get('z')[axis] >= minimum);
    assert.ok(result.get('a')[axis] - result.get('m')[axis] >= minimum);
    const reversed = layoutGraph({ ...graph, edges: graph.edges.map(({ source, target }) => edge(target, source)) }, { algorithm });
    assert.ok(reversed.get('z')[axis] > reversed.get('m')[axis] && reversed.get('m')[axis] > reversed.get('a')[axis]);
  }
});

test('SCC condensation handles cycles, outgoing dependencies, and isolated components without overlap', () => {
  const graph = { nodes: makeNodes(9), edges: [
    edge(id(0), id(1)), edge(id(1), id(0)), edge(id(1), id(2)),
    edge(id(2), id(3)), edge(id(3), id(4)), edge(id(4), id(2)), edge(id(4), id(5)),
    edge(id(7), id(8)), edge(id(8), id(7)),
  ] };
  for (const algorithm of ['hierarchy', 'dependency']) {
    const result = layoutGraph(graph, { algorithm });
    assertPositions(result, 9);
    const axis = algorithm === 'hierarchy' ? 'y' : 'x';
    const distance = algorithm === 'hierarchy' ? 184 : 270;
    const firstEnd = Math.max(...[0, 1].map(i => result.get(id(i))[axis]));
    const secondStart = Math.min(...[2, 3, 4].map(i => result.get(id(i))[axis]));
    const secondEnd = Math.max(...[2, 3, 4].map(i => result.get(id(i))[axis]));
    assert.ok(secondStart - firstEnd >= distance, 'every target in the next SCC follows the preceding SCC');
    assert.ok(result.get(id(5))[axis] - secondEnd >= distance);
    const main = bounds([0, 1, 2, 3, 4, 5].map(i => result.get(id(i))));
    const isolated = bounds([6].map(i => result.get(id(i))));
    assert.ok(isolated.x >= main.right || isolated.y >= main.bottom ||
      main.x >= isolated.right || main.y >= isolated.bottom, 'disconnected components have disjoint bounds');
  }
});

test('crossing reduction untangles sibling dependencies in both flow directions', () => {
  const graph = { nodes: ['root', 'a', 'b', 'c', 'd', 'sink'].map(id => ({ id })), edges: [
    edge('root', 'a'), edge('root', 'b'), edge('a', 'd'), edge('b', 'c'), edge('c', 'sink'), edge('d', 'sink'),
  ] };
  for (const algorithm of ['hierarchy', 'dependency']) {
    const result = layoutGraph(graph, { algorithm }), cross = algorithm === 'hierarchy' ? 'x' : 'y';
    assert.ok((result.get('a')[cross] - result.get('b')[cross]) *
      (result.get('d')[cross] - result.get('c')[cross]) > 0, 'the two sibling edges do not cross');
    assertPositions(result, 6);
  }
});

test('missing endpoints, malformed edges, self-loops, and parallel relations do not bias layouts', () => {
  const graph = { nodes: makeNodes(8), edges: [edge(id(0), id(3)), edge(id(3), id(6))] };
  const noisy = { ...graph, edges: [
    null, 0, false, {}, [], edge('missing', id(0)), edge(id(1), {}), edge(0, id(1)),
    ...graph.edges, ...graph.edges.map(value => ({ ...value, relation: 'writes' })),
    ...graph.nodes.map(node => edge(node.id, node.id)),
  ] };
  for (const algorithm of LAYOUT_ALGORITHMS) {
    assert.deepEqual(entries(layoutGraph(noisy, { algorithm })), entries(layoutGraph(graph, { algorithm })));
  }
});

test('all algorithms are deterministic under node/edge reordering and irrelevant metadata changes', () => {
  const graph = { nodes: makeNodes(28), edges: [
    ...Array.from({ length: 22 }, (_, i) => edge(id(i), id((i + 1) % 22))),
    edge(id(21), id(22)), edge(id(22), id(23)), edge(id(23), id(24)),
  ] };
  for (const algorithm of LAYOUT_ALGORITHMS) {
    const expected = entries(layoutGraph(graph, { algorithm }));
    for (let seed = 1; seed <= 5; seed++) {
      const reordered = { nodes: shuffled(graph.nodes, seed).map(node => ({ ...node, label: `different ${seed}` })),
        edges: shuffled(graph.edges, seed + 73).map((value, i) => ({ ...value, id: `different-edge-${i}` })) };
      assert.deepEqual(entries(layoutGraph(reordered, { algorithm })), expected);
    }
    assert.deepEqual(expected.map(([id]) => id), graph.nodes.map(node => node.id).sort());
  }
  for (const algorithm of LAYOUT_ALGORITHMS.filter(value => value !== 'grouped')) {
    assert.deepEqual(layoutGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, kind: 'changed-kind' })) }, { algorithm }),
      layoutGraph(graph, { algorithm }), 'kinds are not treated as direction or ownership');
  }
});

test('grouped layout places each kind in a separate block with visible gaps', () => {
  const graph = { nodes: makeNodes(90), edges: [] }, positions = layoutGraph(graph, { algorithm: 'grouped' });
  const blocks = kinds.map(kind => bounds(graph.nodes.filter(node => node.kind === kind).map(node => positions.get(node.id))));
  for (let a = 0; a < blocks.length; a++) for (let b = a + 1; b < blocks.length; b++) {
    const left = blocks[a], right = blocks[b];
    assert.ok(right.x - left.right >= 160 || left.x - right.right >= 160 ||
      right.y - left.bottom >= 160 || left.y - right.bottom >= 160);
  }
  assertPositions(positions, 90);
});

test('original preserves finite pairs and existing overlaps while filling invalid pairs in free cells', () => {
  const graph = { nodes: [
    { id: 'a', x: -18.5, y: 0 }, { id: 'b', x: -18.5, y: 0 },
    { id: 'c', x: 1e308, y: -1e308 }, { id: 'd', x: NaN, y: 0 },
    { id: 'e', x: Infinity, y: 'not-a-number' }, { id: 'f' },
  ], edges: [] };
  const positions = layoutGraph(graph, { algorithm: 'original' });
  for (const node of graph.nodes.slice(0, 3)) assert.deepEqual(positions.get(node.id), { x: node.x, y: node.y });
  assertPositions(positions, 6, { overlap: true });
  assertPositions(new Map([...positions].filter(([id]) => id !== 'b')), 5);
  assert.deepEqual(entries(layoutGraph({ ...graph, nodes: [...graph.nodes].reverse() }, { algorithm: 'original' })), entries(positions));
  assertPositions(layoutGraph({ nodes: makeNodes(256).map(({ id }) => ({ id })), edges: [] }, { algorithm: 'original' }), 256);
});

test('duplicate IDs are resolved deterministically and malformed node records cannot create positions', () => {
  const graph = { nodes: [
    { id: '__proto__', x: 0, y: 0 }, { id: 'same', kind: 'service', x: 10, y: 20 },
    { id: 'same', kind: 'client' }, { id: 'same', kind: 'service', x: 30, y: 40 },
    null, [], {}, { id: '' }, { id: 123 }, { id: 'x'.repeat(257) },
  ], edges: [] };
  for (const algorithm of LAYOUT_ALGORITHMS) {
    const result = layoutGraph(graph, { algorithm });
    assertPositions(result, 2, { overlap: algorithm === 'original' });
    assert.deepEqual(entries(result), entries(layoutGraph({ ...graph, nodes: [...graph.nodes].reverse() }, { algorithm })));
  }
  assert.deepEqual(layoutGraph(graph, { algorithm: 'original' }).get('same'), { x: 10, y: 20 });
});

test('256 nodes and 768 edges stay finite, deterministic, and nonoverlapping across dense, cyclic, and isolated graphs', () => {
  const nodes = makeNodes(256);
  const dagEdges = [];
  for (let delta = 1; dagEdges.length < 768; delta++) {
    for (let i = 0; i + delta < nodes.length && dagEdges.length < 768; i++) dagEdges.push(edge(id(i), id(i + delta)));
  }
  const graphs = [
    { nodes, edges: [] },
    { nodes, edges: nodes.flatMap((_, i) => [1, 7, 31].map(delta => edge(id(i), id((i + delta) % nodes.length)))) },
    { nodes, edges: dagEdges },
    { nodes, edges: Array.from({ length: 16 }, (_, source) =>
      Array.from({ length: 48 }, (_, target) => edge(id(source), id(target + 16)))).flat() },
  ];
  for (const graph of graphs) for (const algorithm of LAYOUT_ALGORITHMS) {
    const positions = layoutGraph(graph, { algorithm });
    assertPositions(positions, 256);
    assert.deepEqual(entries(layoutGraph({ nodes: [...nodes].reverse(), edges: [...graph.edges].reverse() }, { algorithm })),
      entries(positions));
  }
});

test('generated layouts avoid collisions with custom dimensions, zero gaps, and narrow or tall nodes', () => {
  const graph = { nodes: makeNodes(256), edges: [] };
  for (const dimensions of [
    { nodeWidth: 320, nodeHeight: 36, gapX: 0, gapY: 0 },
    { nodeWidth: 1, nodeHeight: 1000, gapX: 0, gapY: 0 },
    { nodeWidth: 110.5, nodeHeight: 53.25, gapX: 1.5, gapY: 3.25 },
  ]) for (const algorithm of generated) {
    assertPositions(layoutGraph(graph, { algorithm, ...dimensions }), 256, dimensions);
  }
});

test('invalid options use finite defaults and extreme dimensions are capped', () => {
  const graph = { nodes: makeNodes(12), edges: [] };
  assert.deepEqual(layoutGraph(graph, null), layoutGraph(graph));
  assert.deepEqual(layoutGraph(graph, {
    algorithm: 'grid', nodeWidth: Infinity, nodeHeight: -1, gapX: NaN, gapY: '80',
  }), layoutGraph(graph, { algorithm: 'grid' }));
  assert.deepEqual(layoutGraph(graph, {
    algorithm: 'grid', nodeWidth: 1e308, nodeHeight: 1e308, gapX: 1e308, gapY: 1e308,
  }), layoutGraph(graph, { algorithm: 'grid', nodeWidth: 10000, nodeHeight: 10000, gapX: 10000, gapY: 10000 }));
});

test('node/edge admission limits select stable IDs and endpoint pairs even when excess inputs are reordered', () => {
  const nodes = makeNodes(300), graph = { nodes, edges: [] };
  for (const algorithm of LAYOUT_ALGORITHMS) {
    const result = layoutGraph(graph, { algorithm });
    assertPositions(result, 256);
    assert.deepEqual([...result.keys()], nodes.slice(0, 256).map(node => node.id));
    assert.deepEqual(entries(result), entries(layoutGraph({ nodes: [...nodes].reverse(), edges: [] }, { algorithm })));
  }
  const edges = [];
  for (let source = 0; source < 64; source++) for (let target = source + 1; target < 64; target++) {
    edges.push(edge(id(source), id(target)));
  }
  const full = { nodes: nodes.slice(0, 64), edges };
  const expected = layoutGraph({ ...full, edges: edges.slice(0, 768) }, { algorithm: 'dependency' });
  assert.deepEqual(layoutGraph(full, { algorithm: 'dependency' }), expected);
  assert.deepEqual(layoutGraph({ ...full, edges: [...edges].reverse() }, { algorithm: 'dependency' }), expected);
  const irrelevant = Array.from({ length: 2000 }, () => edge('absent', id(0)));
  assert.deepEqual(layoutGraph({ ...full, edges: [...irrelevant, ...edges] }, { algorithm: 'dependency' }), expected);
});

test('pathological array lengths stop before scanning entries', () => {
  const tooManyNodes = [], tooManyEdges = [];
  tooManyNodes.length = 1_000_000;
  tooManyEdges.length = 1_000_000;
  for (const list of [tooManyNodes, tooManyEdges]) {
    Object.defineProperty(list, 0, { get() { throw new Error('must_not_scan'); } });
  }
  assert.deepEqual(layoutGraph({ nodes: tooManyNodes, edges: [] }), new Map());
  assert.deepEqual(layoutGraph({ nodes: makeNodes(1), edges: tooManyEdges }), new Map());
});
