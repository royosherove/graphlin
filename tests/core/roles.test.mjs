import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle,
  compileDecision, emptyGraph, applyPatch, projectGraph, invalidateArtifacts,
} from '../../runtime/core/index.mjs';
import { GENERIC_LABELS, ROLES, ROLE_LABELS, ROLE_SHAPES, SHAPES, hash, opaque } from '../../runtime/core/common.mjs';

const expected = {
  client: ['browser', 'Client'], service: ['component', 'Service'], datastore: ['cylinder', 'Datastore'],
  queue: ['queue', 'Queue'], external: ['cloud', 'External'], module: ['rect', 'Module'],
  function: ['hexagon', 'Function'], class: ['class_box', 'Class'], interface: ['interface_box', 'Interface'],
  event: ['document', 'Event'], configuration: ['parallelogram', 'Configuration'], package: ['folder', 'Package'],
};
const legacyRoles = ['client', 'service', 'datastore', 'queue', 'external', 'module'];
const legacyShapes = ['rounded_rect', 'rect', 'cylinder', 'cloud', 'diamond', 'group'];
const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ id: 'role-event', projectId: 'role-project', sessionId: 'role-session',
  kind: 'artifact.changed', incomplete: false });
function prepare(text = Object.keys(expected).map((_, i) => `const component${i} = {};`).join('\n')) {
  const artifact = {
    id: opaque('artifact', 'roles.ts'), relativePath: 'roles.ts', text, hash: hash(text),
    generation: 1, status: 'present', exists: true, complete: true,
  };
  const candidates = buildCandidates({ event, artifacts: [artifact], policy });
  const bundle = materializeBundle({ candidates, policy, verdicts: candidates.map(c =>
    ({ candidateId: c.id, digest: c.digest, sensitive: 0.01, relevant: 0.99 })) });
  return { artifact, candidates, bundle };
}
function judgment(candidate, role) {
  return {
    candidateId: candidate.id, role, supportProbability: 0.99, roleProbability: 0.99, roleConfidence: 0.95,
    roleProbabilities: Object.fromEntries([...Object.keys(expected), 'unknown']
      .map(option => [option, option === role ? 0.99 : option === 'unknown' ? 0.01 : 0])),
    classification: 'accepted',
  };
}
function allRoles() {
  const input = prepare();
  const decision = { status: 'accepted', bundle: input.bundle,
    nodes: input.candidates.map((c, i) => judgment(c, Object.keys(expected)[i])), edges: [] };
  const patch = compileDecision(emptyGraph(), { event, decision, policy });
  assert.ok(patch, 'all thirteen probability entries are accepted');
  return { ...input, decision, graph: applyPatch(emptyGraph(), patch) };
}

test('all twelve roles compile with the agreed shapes and fixed generic labels', () => {
  const { graph } = allRoles();
  assert.equal(graph.nodes.length, 12);
  assert.equal(new Set(SHAPES).size, 15);
  assert.deepEqual(new Set(ROLES), new Set(Object.keys(expected)));
  for (const node of graph.nodes) {
    const [shape, label] = expected[node.kind];
    assert.equal(node.shape, shape);
    assert.equal(ROLE_SHAPES[node.kind], shape);
    assert.equal(ROLE_LABELS[node.kind], label);
    assert.equal(node.classification, 'accepted');
    assert.equal(node.evidenceState, 'observed');
  }
  for (const projected of [
    projectGraph(graph, policy, { persistent: true }),
    projectGraph(graph, createPolicy({ ...policy, displayEvidence: false })),
  ]) {
    for (const node of projected.nodes) {
      assert.equal(node.label, expected[node.kind][1]);
      assert.ok(node.sourceRefs.every(ref => !Object.hasOwn(ref, 'excerpt')));
    }
  }
});

test('thirteen-entry distributions still reject extra keys, bad sums, nonfinite values, and inconsistent winners', () => {
  const { decision } = allRoles();
  for (const mutate of [
    node => { node.roleProbabilities.foreign_role = 0; },
    node => { node.roleProbabilities.function = NaN; },
    node => { node.roleProbabilities.unknown = 0.5; },
    node => { node.roleProbability = 0.5; },
    node => { node.role = 'invented'; },
  ]) {
    const nodes = structuredClone(decision.nodes);
    mutate(nodes[0]);
    assert.equal(compileDecision(emptyGraph(), { event, decision: { ...decision, nodes }, policy }), null);
  }
  const node = { ...decision.nodes[0], role: 'unknown', roleProbability: 0.99,
    roleProbabilities: Object.fromEntries([...ROLES, 'unknown'].map(role => [role, role === 'unknown' ? 0.99 : role === 'module' ? 0.01 : 0])) };
  assert.equal(compileDecision(emptyGraph(), { event, decision: { ...decision, nodes: [node] }, policy }), null);
});

test('new roles preserve the existing support floor and accepted-claim thresholds', () => {
  const { decision } = allRoles();
  const below = decision.nodes.map(node => ({ ...node, supportProbability: 0.499 }));
  assert.equal(compileDecision(emptyGraph(), { event, decision: { ...decision, nodes: below }, policy }), null);
  const boundary = decision.nodes.map(node => ({ ...node, supportProbability: 0.5 }));
  const patch = compileDecision(emptyGraph(), { event, decision: { ...decision, nodes: boundary }, policy });
  const graph = applyPatch(emptyGraph(), patch);
  assert.equal(graph.nodes.length, 12);
  assert.ok(graph.nodes.every(node => node.classification === 'tentative'));
});

test('every legacy role and shape combination survives restore without reinterpretation', () => {
  const seed = allRoles().graph.nodes[0], nodes = [];
  for (const kind of legacyRoles) for (const shape of legacyShapes) {
    nodes.push({ ...seed, id: opaque('node', kind, shape), kind, shape, x: 17 + nodes.length * 100, y: 83 });
  }
  const restored = applyPatch(emptyGraph(), {
    schemaVersion: 1, id: 'restore', baseRevision: 0, revision: 1, causedBy: [],
    operations: nodes.map(node => ({ op: 'node.upsert', node })),
  });
  assert.deepEqual(restored.nodes, nodes);
  assert.equal(restored.schemaVersion, 1);
  const projected = projectGraph(restored, policy);
  assert.deepEqual(projected.nodes.map(n => [n.id, n.kind, n.shape, n.x, n.y]),
    nodes.map(n => [n.id, n.kind, n.shape, n.x, n.y]));
});

test('fresh role classification preserves entity identity, coordinates, and source versions', () => {
  const { candidates, bundle } = prepare('export function saveWidget() {}');
  const initial = { status: 'accepted', bundle, nodes: [judgment(candidates[0], 'module')], edges: [] };
  const old = applyPatch(emptyGraph(), compileDecision(emptyGraph(), { event, decision: initial, policy }));
  old.nodes[0].x = 17;
  old.nodes[0].y = 83;
  const changed = { ...initial, nodes: [judgment(candidates[0], 'function')] };
  const updated = applyPatch(old, compileDecision(old, { event, decision: changed, policy }));
  assert.equal(old.nodes[0].kind, 'module');
  assert.equal(updated.nodes[0].kind, 'function');
  assert.equal(updated.nodes[0].shape, 'hexagon');
  assert.equal(updated.nodes[0].id, old.nodes[0].id);
  assert.deepEqual([updated.nodes[0].x, updated.nodes[0].y], [17, 83]);
  assert.deepEqual(updated.nodes[0].sourceRefs, old.nodes[0].sourceRefs);
});

test('interface names already pass source discovery and compile to interface boxes with exact provenance', () => {
  const { candidates, bundle } = prepare('export interface WidgetPort { send(): void; }');
  assert.deepEqual(candidates.map(c => c.label), ['WidgetPort']);
  assert.equal(candidates[0].labelOrigin.type, 'span');
  const decision = { status: 'accepted', bundle, nodes: [judgment(candidates[0], 'interface')], edges: [] };
  const graph = applyPatch(emptyGraph(), compileDecision(emptyGraph(), { event, decision, policy }));
  assert.equal(graph.nodes[0].shape, 'interface_box');
  assert.equal(graph.nodes[0].label, 'WidgetPort');
  assert.deepEqual(graph.nodes[0].sourceRefs[0].sourceRef, candidates[0].sourceRef);
});

test('all expanded kinds retain independent invalidation and deletion behavior', () => {
  const { graph, artifact } = allRoles();
  const changed = { ...artifact, hash: hash('changed'), generation: 2 };
  const stale = applyPatch(graph, invalidateArtifacts(graph, [changed]));
  assert.equal(stale.nodes.length, 12);
  assert.ok(stale.nodes.every(node => node.validity === 'stale' && node.shape === expected[node.kind][0]));
  const missing = { ...artifact, hash: null, text: null, status: 'missing', exists: false, generation: 3 };
  const removed = applyPatch(stale, invalidateArtifacts(stale, [missing]));
  assert.deepEqual(removed.nodes, []);
  assert.deepEqual(removed.edges, []);
});

test('graph and candidate schemas match the expanded grammar without rejecting legacy shapes', async () => {
  const graph = JSON.parse(await readFile(new URL('../../schemas/graph.schema.json', import.meta.url), 'utf8'));
  const bundle = JSON.parse(await readFile(new URL('../../schemas/bundle.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(new Set(graph.$defs.node.properties.kind.enum), new Set(Object.keys(expected)));
  assert.deepEqual(new Set(graph.$defs.node.properties.shape.enum), new Set(SHAPES));
  const generic = bundle.$defs.candidate.properties.labelOrigin.oneOf.find(branch => branch.properties.type.const === 'generic');
  assert.deepEqual(new Set(generic.properties.label.enum), new Set(GENERIC_LABELS));
  for (const [, label] of Object.values(expected)) assert.ok(generic.properties.label.enum.includes(label));
  assert.ok(legacyShapes.every(shape => graph.$defs.node.properties.shape.enum.includes(shape)));
});
