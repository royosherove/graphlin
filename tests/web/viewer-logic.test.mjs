import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  safeText, normalizeGraph, normalizeSnapshot, normalizeConfidence,
  claimSummary, graphBounds, routeEdge, edgeLanes, graphEdgeRoutes, historyFrames, reconcileReplayFrame,
  sanitizedExport, parseLaunchToken, exchangeLaunchToken, coverageSummary,
} from '../../runtime/web/app.js';
import { graph, node, reference, snapshot } from './fixtures.mjs';

test('untrusted graph attributes cannot choose SVG elements, styles, or endpoints', () => {
  const input = graph(3, {
    nodes: [
      node('api', { shape: 'script', label: '<img src=x onerror=alert(1)>', x: Infinity, y: '12;alert(1)', onclick: 'unsafe' }),
      node('database', { x: 480, y: -30 }),
      node('database', { label: 'duplicate' }),
    ],
    edges: [
      { ...graph().edges[0], style: 'url(https://untrusted.example)' },
      { ...graph().edges[0], id: 'missing', target: 'missing' },
      { ...graph().edges[0], id: 'unknown', relation: 'javascript:alert(1)' },
    ],
  });
  const result = normalizeGraph(input);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 1);
  assert.equal(result.nodes[0].shape, 'component');
  assert.equal(result.nodes[0].label, '<img src=x onerror=alert(1)>');
  assert.ok(Number.isFinite(result.nodes[0].x));
  assert.ok(Number.isFinite(result.nodes[0].y));
  assert.equal(result.nodes[1].x, 480);
  assert.equal(result.nodes[1].y, -30);
  assert.equal('onclick' in result.nodes[0], false);
  assert.equal('style' in result.edges[0], false);
  assert.equal(input.nodes[0].x, Infinity, 'input remains untouched');
});

test('layout positions remain stable across node order and graph changes', () => {
  const first = normalizeGraph(graph(1, { nodes: [node('api', { x: NaN, y: NaN }), node('database')] }));
  const second = normalizeGraph(graph(2, { nodes: [node('other'), node('database'), node('api', { x: NaN, y: NaN })] }));
  for (const original of first.nodes) {
    const updated = second.nodes.find(item => item.id === original.id);
    assert.equal(updated.x, original.x);
    assert.equal(updated.y, original.y);
  }
  const bounds = graphBounds(first);
  assert.ok(Object.values(bounds).every(Number.isFinite));
  assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('edge geometry is finite for forward, reverse, vertical, coincident, and self edges', () => {
  for (const [source, target] of [
    [node('a', { x: 0, y: 0 }), node('b', { x: 400, y: 0 })],
    [node('a', { x: 400, y: 0 }), node('b', { x: 0, y: 0 })],
    [node('a', { x: 0, y: 0 }), node('b', { x: 0, y: 400 })],
    [node('a', { x: 0, y: 0 }), node('b', { x: 0, y: 0 })],
    [node('a'), node('a')],
  ]) {
    const route = routeEdge(source, target, 20);
    assert.doesNotMatch(route.d, /NaN|Infinity|undefined/);
    assert.match(route.d, /^M [-\d. ]+ C [-\d. ]+$/);
    assert.ok(Number.isFinite(route.x) && Number.isFinite(route.y));
  }
});

function parallelGraph(targetPosition = { x: 430, y: 0 }) {
  const base = graph();
  return {
    ...base,
    nodes: [node('api', { x: 0, y: 0 }), node('database', targetPosition)],
    edges: ['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'].flatMap(relation => [
      { ...base.edges[0], id: `forward-${relation}`, source: 'api', target: 'database', relation, label: relation },
      { ...base.edges[0], id: `reverse-${relation}`, source: 'database', target: 'api', relation, label: relation },
    ]),
  };
}

test('all six relations in both directions have distinct arcs and separated labels', () => {
  for (const position of [{ x: 430, y: 0 }, { x: 0, y: 330 }, { x: 430, y: 330 }]) {
    const input = parallelGraph(position);
    const routes = [...graphEdgeRoutes(input).values()];
    assert.equal(new Set(routes.map(route => route.d)).size, 12, 'reverse and parallel arrows never share a curve');
    const distance = Math.hypot(position.x, position.y);
    const normal = { x: -position.y / distance, y: position.x / distance };
    const labelOffsets = routes.map(route => route.x * normal.x + route.y * normal.y).sort((a, b) => a - b);
    for (let i = 1; i < labelOffsets.length; i += 1) {
      assert.ok(labelOffsets[i] - labelOffsets[i - 1] >= 30, 'labels occupy separate perpendicular lanes');
    }
    for (const route of routes) {
      assert.ok(route.angle >= -90 && route.angle < 90, 'labels remain upright');
      assert.doesNotMatch(route.d, /NaN|Infinity|undefined/);
    }
    if (position.x === 0) assert.ok(routes.every(route => route.angle === -90), 'vertical labels follow their curves rather than stacking horizontally');
  }
});

test('edge routes are stable across reordered snapshots and other relation changes', () => {
  const input = parallelGraph();
  const before = structuredClone(input);
  const routes = graphEdgeRoutes(input);
  const reordered = graphEdgeRoutes({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
  for (const [id, route] of routes) assert.deepEqual(reordered.get(id), route);
  const pair = { ...input, edges: input.edges.filter(edge => ['forward-writes', 'forward-calls'].includes(edge.id)) };
  assert.deepEqual(graphEdgeRoutes(pair).get('forward-writes'), routes.get('forward-writes'), 'parallel writes remains in its slot when other parallel types change');
  assert.deepEqual(input, before, 'routing does not modify IDs or compiler-owned node positions');
});

test('an isolated relationship is straight and its short-gap label stays clear of both nodes', () => {
  const input = graph(1, { nodes: [node('api', { x: 0, y: 0 }), node('database', { x: 220, y: 0 })] });
  const route = graphEdgeRoutes(input).get(input.edges[0].id);
  assert.equal(edgeLanes(input.edges).get(input.edges[0].id), 0);
  assert.equal(route.d, 'M 190 52 C 200 52 210 52 220 52', 'a 30px gap has a straight arrow, not a U-shaped arc');
  assert.ok(route.y + route.labelHeight / 2 < 0, 'the readable label is above both nodes');
  assert.ok(route.labelWidth <= 198 && route.labelHeight === 26, 'the hit region is only a small label background');
  assert.match(route.leader, /^M 205 52 L /);
  const bounds = graphBounds(input);
  assert.ok(route.y - route.labelHeight / 2 >= bounds.y, 'Fit includes the relocated label');
  input.edges[0] = { ...input.edges[0], source: 'database', target: 'api' };
  const reverse = graphEdgeRoutes(input).get(input.edges[0].id);
  assert.equal(reverse.d, 'M 220 52 C 210 52 200 52 190 52');
});

test('parallel short-gap labels stay distinct outside node silhouettes', () => {
  const input = parallelGraph({ x: 220, y: 0 });
  const routes = [...graphEdgeRoutes(input).values()];
  const ys = routes.map(route => route.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 36);
  for (const route of routes) {
    assert.ok(route.y + route.labelHeight / 2 < 0 || route.y - route.labelHeight / 2 > 104);
  }
});

test('same-type edge IDs get deterministic additional lanes without displacing other relations', () => {
  const input = parallelGraph();
  const duplicate = { ...input.edges[0], id: 'forward-calls-extra' };
  const edges = [...input.edges, duplicate];
  const lanes = edgeLanes(edges);
  const reversed = edgeLanes([...edges].reverse());
  assert.equal(new Set(lanes.values()).size, edges.length);
  for (const [id, lane] of lanes) assert.equal(reversed.get(id), lane);
  assert.equal(lanes.get('forward-writes'), edgeLanes(input.edges).get('forward-writes'));
  assert.equal(new Set([...graphEdgeRoutes({ ...input, edges }).values()].map(route => route.d)).size, edges.length);
});

test('Fit includes outer curves and their labels without altering node layout', () => {
  const input = parallelGraph({ x: 0, y: 330 });
  const routes = graphEdgeRoutes(input);
  const bounds = graphBounds(input, routes);
  for (const route of routes.values()) {
    assert.ok(route.bounds.minX >= bounds.x && route.bounds.maxX <= bounds.x + bounds.width);
    assert.ok(route.bounds.minY >= bounds.y && route.bounds.maxY <= bounds.y + bounds.height);
    assert.ok(route.x > bounds.x && route.x < bounds.x + bounds.width);
    assert.ok(route.y > bounds.y && route.y < bounds.y + bounds.height);
  }
  assert.deepEqual(input.nodes.map(({ x, y }) => [x, y]), [[0, 0], [0, 330]]);
});

test('parallel self references get distinct finite loops', () => {
  const source = node('api');
  const routes = [0, .5, 1.5, 2.5, -1.5].map(lane => routeEdge(source, source, lane));
  assert.equal(new Set(routes.map(route => route.d)).size, routes.length);
  for (const route of routes) assert.ok([route.x, route.y, route.angle, ...Object.values(route.bounds)].every(Number.isFinite));
});

test('malformed current snapshots are rejected; malformed history cannot replace a valid graph', () => {
  assert.throws(() => normalizeSnapshot({ schemaVersion: 2 }), /invalid_snapshot/);
  assert.throws(() => normalizeSnapshot(snapshot({ graph: { schemaVersion: 1 } })), /invalid_snapshot/);
  const result = normalizeSnapshot(snapshot({ history: [{ revision: 900, graph: { schemaVersion: 8 } }] }));
  assert.equal(result.graph.revision, 2);
  assert.deepEqual(result.history, []);
});

test('invalid and missing confidence remains absent rather than becoming zero', () => {
  assert.deepEqual(normalizeConfidence(undefined), {});
  assert.deepEqual(normalizeConfidence({ supportProbability: NaN, roleProbability: -1, roleConfidence: 2, missingContextProbability: '0' }), {});
  assert.deepEqual(normalizeConfidence({ supportProbability: 0 }), { supportProbability: 0 });
  assert.deepEqual(normalizeConfidence(.8), { reportedConfidence: .8 });
  assert.deepEqual(normalizeConfidence({ roleProbabilities: { service: .6, unknown: .4, '<script>': 1 } }), { roleProbabilities: { service: .6, unknown: .4 } });
});

test('source interpretation and even a reported verified state never imply runtime verification', () => {
  const source = claimSummary(node());
  assert.equal(source.label, 'Code evidence');
  assert.match(source.explanation, /without proving/);
  const verified = claimSummary(node('api', { evidenceState: 'verified' }));
  assert.equal(verified.label, 'Code evidence');
  const proposed = claimSummary(node('api', { sourceRefs: [reference({ sourceClass: 'public_intent' })] }));
  assert.equal(proposed.label, 'Proposed');
  const stale = claimSummary(node('api', { evidenceState: 'verified', validity: 'stale' }));
  assert.equal(stale.label, 'Evidence stale');
  assert.equal(claimSummary(node('api', { sourceRefs: [] })).label, 'Provenance incomplete');
  assert.equal(claimSummary(node('api', { validity: 'retracted' })).label, 'Support retracted');
});

test('history is ordered by revision, resynchronizes current projection, and keeps a pinned revision', () => {
  const raw = snapshot({
    graph: graph(5),
    history: [
      { revision: 3, at: 20, graph: graph(3) },
      { revision: 1, at: 10, graph: graph(1) },
      { revision: 5, at: 30, graph: graph(5, { nodes: [node('api', { label: 'Old projection' })], edges: [] }) },
    ],
  });
  const frames = historyFrames(normalizeSnapshot(raw));
  assert.deepEqual(frames.map(frame => frame.revision), [1, 3, 5]);
  assert.equal(frames[2].graph.nodes[0].label, 'Notes API');
  const pinned = frames[0];
  const evicted = reconcileReplayFrame(frames.slice(1), pinned);
  assert.equal(evicted.revision, 1);
  assert.equal(evicted.graph.nodes[0].label, pinned.graph.nodes[0].label);
  assert.equal('excerpt' in evicted.graph.nodes[0].sourceRefs[0], false);
  assert.ok(pinned.graph.nodes[0].sourceRefs[0].excerpt, 'retained source input was not mutated');
});

test('replay takes the service’s latest privacy projection without changing its selected revision', () => {
  const pinned = historyFrames(normalizeSnapshot(snapshot()))[0];
  const projected = historyFrames(normalizeSnapshot(snapshot(), { includeExcerpts: false }));
  const result = reconcileReplayFrame(projected, pinned);
  assert.equal(result.revision, pinned.revision);
  assert.equal('excerpt' in result.graph.nodes[0].sourceRefs[0], false);
});

test('export recursively allowlists metadata and omits all excerpts and unknown fields', () => {
  const secret = 'NEVER_EXPORT_PRIVATE_SENTINEL';
  const input = snapshot();
  input.apiKey = secret;
  input.sessionStates = [{ raw: secret }];
  input.status.error = secret;
  input.status.coverage = { tools: true, credentials: secret };
  input.sessions[0].privatePath = secret;
  input.graph.nodes[0].rawSource = secret;
  input.graph.nodes[0].sourceRefs[0].excerpt = secret;
  input.graph.nodes[0].sourceRefs[0].path = secret;
  input.graph.edges[0].sourceRefs[0].excerpt = secret;
  input.history[0].graph.nodes[0].sourceRefs[0].excerpt = secret;
  input.history[0].graph.edges[0].sourceRefs[0].excerpt = secret;
  input.activity[0].command = secret;
  const exported = sanitizedExport(input);
  assert.equal(JSON.stringify(exported).includes(secret), false);
  assert.equal(JSON.stringify(exported).includes('"excerpt"'), false);
  assert.equal(exported.graph.nodes[0].sourceRefs[0].basis, 'jev_interpretation');
  assert.equal(exported.history[0].graph.nodes[0].sourceRefs[0].generation, 1);
  assert.equal(input.graph.nodes[0].sourceRefs[0].excerpt, secret);
});

test('exports preserve scalar confidence, absent confidence, message provenance, and ISO timestamps', () => {
  const input = snapshot();
  input.graph.nodes[0].confidence = .87;
  delete input.graph.edges[0].confidence;
  input.graph.nodes[0].sourceRefs = [reference({
    artifactId: 'message-1', sourceClass: 'public_intent',
    sourceRef: { type: 'message', messageId: 'message-1', hash: 'a'.repeat(64), contentVersion: 1, privateBody: 'not exported' },
  })];
  const exported = sanitizedExport(input);
  assert.equal(exported.graph.nodes[0].confidence, .87);
  assert.equal('confidence' in exported.graph.edges[0], false);
  assert.deepEqual(exported.graph.nodes[0].sourceRefs[0].sourceRef, {
    type: 'message', messageId: 'message-1', hash: 'a'.repeat(64), contentVersion: 1,
  });
  assert.equal(exported.activity[0].at, '2026-09-19T09:00:00.000Z');
  assert.equal(exported.history[0].at, '2026-09-19T09:00:00.000Z');
});

test('text is bounded, bidi controls are removed, and markup remains literal text', () => {
  assert.equal(safeText('api\u202efake\u2066\u0000'), 'apifake');
  assert.equal(safeText('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(safeText('x'.repeat(500)).length, 180);
  assert.equal(safeText({ toString() { throw new Error('must not call'); } }), '');
});

test('launch token supports the contracted token fragment and never accepts URL/script input', () => {
  const token = 'a'.repeat(43);
  assert.equal(parseLaunchToken(`#token=${token}`), token);
  assert.equal(parseLaunchToken(`#${token}`), token);
  assert.equal(parseLaunchToken(''), null);
  assert.equal(parseLaunchToken('#main'), null);
  assert.throws(() => parseLaunchToken(`#token=${token}&token=${token}`), /invalid_launch/);
  assert.throws(() => parseLaunchToken('#token=javascript:alert(1)'), /invalid_launch/);
  assert.throws(() => parseLaunchToken(`#${'a'.repeat(3000)}`), /invalid_launch/);
});

test('auth posts only the fragment token and erases it after both success and failure', async () => {
  for (const fail of [false, true]) {
    const token = 'b'.repeat(43);
    const calls = [];
    const location = { hash: `#token=${token}`, pathname: '/', search: '' };
    const history = { state: { existing: true }, replaceState(...args) { calls.push(['erase', ...args]); } };
    const run = exchangeLaunchToken({ location, history, request: async (...args) => {
      calls.push(['request', ...args]);
      if (fail) throw new Error('auth_required');
      return { ok: true };
    } });
    if (fail) await assert.rejects(run, /auth_required/);
    else await run;
    assert.deepEqual(calls[0], ['request', '/api/auth', { method: 'POST', body: JSON.stringify({ token }) }]);
    assert.deepEqual(calls[1], ['erase', { existing: true }, '', '/']);
  }
});

test('a malformed fragment is erased without making any auth request', async () => {
  const calls = [];
  await assert.rejects(exchangeLaunchToken({
    location: { hash: '#token=<script>', pathname: '/', search: '' },
    history: { state: null, replaceState(...args) { calls.push(args); } },
    request: async () => { assert.fail('invalid tokens must never be sent'); },
  }), /invalid_launch/);
  assert.deepEqual(calls, [[null, '', '/']]);
});

test('coverage stays qualified when the service supplies no coverage data', () => {
  assert.equal(coverageSummary(null), 'Coverage not reported');
  assert.equal(coverageSummary('tools_only', 2), 'Coverage: tools only · 2 dropped');
  assert.match(coverageSummary({ tools: true, publicIntent: false, gaps: 3 }), /Tools only.*3 reported gaps/);
  assert.match(coverageSummary(0), /No reported/);
});

test('the page uses local external assets and no executable data interpolation', async () => {
  const [html, source] = await Promise.all([
    readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../runtime/web/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\bon(?:click|load|error|input|change)\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|document\.cookie/);
});
