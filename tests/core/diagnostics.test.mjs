import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle, buildRelationProposals,
  emptyGraph, compileDecision, applyPatch, invalidateArtifacts,
} from '../../runtime/core/index.mjs';
import { LIMITS, freeze, hash, isId, opaque } from '../../runtime/core/common.mjs';
import { proposalId } from '../../runtime/core/candidates.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ id: 'compiler-audit-event', kind: 'artifact.changed', incomplete: false });
const reasons = new Set([
  'admitted', 'already_current', 'support_below_floor', 'unknown_role', 'stale_generation',
  'node_limit', 'edge_limit', 'graph_byte_limit', 'endpoints_not_drawable', 'reference_limit',
  'revision_limit', 'invalid_graph', 'decision_not_compilable', 'invalid_bundle', 'invalid_event',
  'invalid_judgments', 'judgment_limit', 'duplicate_judgments', 'empty_decision', 'no_change', 'no_drawable_change',
]);

function fixture({ generation = 1, artifactCount } = {}) {
  const artifacts = Array.from({ length: artifactCount ?? 1 }, (_, i) => {
    const text = artifactCount
      ? `export function Unit${i}() { return "SOURCE_BODY_SENTINEL"; }`
      : 'export function saveNote(note) { return PostgreSQL.insert(note); }';
    return {
      id: opaque('artifact', 'compiler-audit', i), relativePath: `private/project/cache-${i}.ts`,
      hash: hash(text), generation, exists: true, status: 'present', complete: true, text,
    };
  });
  const candidates = buildCandidates({ event, policy, artifacts });
  const bundle = materializeBundle({
    policy, candidates, verdicts: candidates.map(c => ({
      candidateId: c.id, digest: c.digest, relevant: 0.99, sensitive: 0.01,
    })),
  });
  return {
    event, policy, artifacts,
    decision: {
      status: 'accepted', bundle,
      nodes: bundle.candidates.map(c => ({
        candidateId: c.id, role: 'module', supportProbability: 0.99,
        roleProbability: 0.99, roleConfidence: 0.95,
        roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
      })),
      edges: buildRelationProposals(bundle).proposals.map(({ id, ...proposal }) => ({
        ...proposal, proposalId: id, supportProbability: 0.99,
        missingContextProbability: 0.01, classification: 'accepted',
      })),
    },
  };
}

function relation(bundle, evidenceCandidateIds = bundle.candidates.map(c => c.id)) {
  const [sourceCandidateId, targetCandidateId] = evidenceCandidateIds;
  return {
    proposalId: proposalId(bundle, sourceCandidateId, targetCandidateId, 'calls', evidenceCandidateIds),
    sourceCandidateId, targetCandidateId, relation: 'calls', evidenceCandidateIds,
    supportProbability: 0.99, missingContextProbability: 0.01, classification: 'accepted',
  };
}

function observe(input, graph = emptyGraph()) {
  const records = [];
  const patch = compileDecision(graph, { ...input, onDiagnostic: record => records.push(record) });
  return { patch, records, graph: patch ? applyPatch(graph, patch) : graph };
}
const judgments = records => records.filter(r => r.candidateId || r.proposalId);

test('audits added, updated and unchanged judgments without changing patches', () => {
  const first = fixture();
  const added = observe(first);
  assert.deepEqual(added.patch, compileDecision(emptyGraph(), first));
  assert.equal(added.records.length, first.decision.nodes.length + first.decision.edges.length);
  assert.ok(added.records.every(r => r.status === 'added' && r.reason === 'admitted'));

  const unchanged = observe(first, added.graph);
  assert.equal(unchanged.patch, null);
  assert.ok(judgments(unchanged.records).every(r => r.status === 'unchanged' && r.reason === 'already_current'));
  assert.deepEqual(unchanged.records.at(-1), { status: 'unchanged', reason: 'no_change' });

  const next = fixture({ generation: 2 });
  const updated = observe(next, added.graph);
  assert.deepEqual(updated.patch, compileDecision(added.graph, next));
  assert.ok(updated.records.every(r => r.status === 'updated' && r.reason === 'admitted'));
  assert.ok(updated.graph.nodes.every(n => n.sourceRefs[0].generation === 2));
});

test('unknown roles and support below 0.5 explain absent nodes and edges', () => {
  const input = fixture();
  Object.assign(input.decision.nodes[0], {
    role: 'unknown', roleProbability: 1, roleProbabilities: { unknown: 1 },
  });
  input.decision.nodes[1].supportProbability = 0.499;
  input.decision.edges.forEach(e => { e.supportProbability = 0.02; });
  const { patch, records } = observe(input);
  assert.equal(patch, null);
  assert.deepEqual(records[0], {
    candidateId: input.decision.nodes[0].candidateId, status: 'skipped', reason: 'unknown_role',
  });
  assert.equal(records[1].reason, 'support_below_floor');
  assert.ok(records.filter(r => r.proposalId).every(r => r.reason === 'support_below_floor'));
  assert.deepEqual(records.at(-1), { status: 'skipped', reason: 'no_drawable_change' });
});

test('the experimental 0.5 boundary remains tentative with auditing enabled', () => {
  const input = fixture();
  [...input.decision.nodes, ...input.decision.edges].forEach(j => { j.supportProbability = 0.5; });
  const { graph, records } = observe(input);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 7);
  assert.ok([...graph.nodes, ...graph.edges].every(item => item.classification === 'tentative'));
  assert.ok(records.every(r => r.status === 'added' && r.reason === 'admitted'));
});

test('supported edges cannot draw endpoints skipped by the node gate', () => {
  const input = fixture();
  input.decision.nodes[0].supportProbability = 0.1;
  const { graph, records } = observe(input);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  assert.ok(records.filter(r => r.proposalId).every(r => r.reason === 'endpoints_not_drawable'));
});

test('same-generation stale nodes and delayed older generations are explained', () => {
  const input = fixture();
  const current = observe(input).graph;
  const stale = applyPatch(current, invalidateArtifacts(current, input.artifacts.map(a => ({
    ...a, generation: 2, status: 'unavailable', exists: null,
  }))));
  const rejected = observe(input, stale);
  assert.equal(rejected.patch, null);
  assert.ok(rejected.records.filter(r => r.candidateId).every(r => r.reason === 'stale_generation'));
  assert.ok(rejected.records.filter(r => r.proposalId).every(r => r.reason === 'endpoints_not_drawable'));

  const refreshed = observe(fixture({ generation: 2 }), stale).graph;
  const delayed = observe(input, refreshed);
  assert.equal(delayed.patch, null);
  assert.ok(delayed.records.filter(r => r.candidateId).every(r => r.reason === 'stale_generation'));
});

test('stale edge evidence is rejected even while its endpoints are drawable', () => {
  const input = fixture({ artifactCount: 3 });
  input.decision.nodes = input.decision.nodes.slice(0, 2);
  input.decision.edges = [relation(input.decision.bundle)];
  const current = observe(input).graph;
  const stale = applyPatch(current, invalidateArtifacts(current, [{
    ...input.artifacts[2], generation: 2, status: 'partial',
  }]));
  const { patch, records } = observe(input, stale);
  assert.equal(patch, null);
  assert.ok(records.filter(r => r.candidateId).every(r => r.reason === 'already_current'));
  assert.equal(records.find(r => r.proposalId).reason, 'stale_generation');
});

test('node capacity has a distinct reason and preserves the existing graph', () => {
  const input = fixture();
  const template = observe(input).graph.nodes[0];
  const graph = {
    ...emptyGraph(),
    nodes: Array.from({ length: LIMITS.nodes }, (_, i) => ({ ...template, id: opaque('node', 'node-capacity', i) })),
  };
  const before = structuredClone(graph);
  const { patch, records } = observe(input, graph);
  assert.equal(patch, null);
  assert.ok(records.filter(r => r.candidateId).every(r => r.reason === 'node_limit'));
  assert.ok(records.filter(r => r.proposalId).every(r => r.reason === 'endpoints_not_drawable'));
  assert.deepEqual(graph, before);
});

test('edge capacity has a distinct reason without removing unchanged endpoints', () => {
  const input = fixture();
  const graph = observe(input).graph;
  const template = graph.edges[0];
  graph.edges = Array.from({ length: LIMITS.edges }, (_, i) => ({
    ...template, id: opaque('edge', 'edge-capacity', i), sourceRefs: [template.sourceRefs[0]],
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(graph)) < LIMITS.admissionBytes);
  const { patch, records } = observe(input, graph);
  assert.equal(patch, null);
  assert.ok(records.filter(r => r.candidateId).every(r => r.reason === 'already_current'));
  assert.ok(records.filter(r => r.proposalId).every(r => r.reason === 'edge_limit'));
});

test('serialized-byte admission limits are explained separately from item counts', () => {
  const input = fixture();
  const template = observe(input).graph.nodes[0];
  const refs = Array.from({ length: LIMITS.refs }, (_, i) => {
    const artifactId = opaque('artifact', 'byte-capacity', i);
    return {
      ...template.sourceRefs[0], artifactId, excerpt: 'x'.repeat(LIMITS.excerptChars),
      sourceRef: { ...template.sourceRefs[0].sourceRef, artifactId },
    };
  });
  const graph = emptyGraph();
  while (Buffer.byteLength(JSON.stringify(graph)) <= LIMITS.admissionBytes) {
    graph.nodes.push({ ...template, id: opaque('node', 'byte-capacity', graph.nodes.length), sourceRefs: refs });
  }
  assert.ok(graph.nodes.length < LIMITS.nodes);
  assert.ok(Buffer.byteLength(JSON.stringify(graph)) < LIMITS.graphBytes);
  const { patch, records } = observe(input, graph);
  assert.equal(patch, null);
  assert.ok(records.filter(r => r.candidateId).every(r => r.reason === 'graph_byte_limit'));
});

test('a relation exceeding the reference budget is explained without dropping dependencies', () => {
  const input = fixture({ artifactCount: LIMITS.refs + 1 });
  assert.equal(input.decision.bundle.candidates.length, LIMITS.refs + 1);
  input.decision.edges = [relation(input.decision.bundle)];
  const { graph, records } = observe(input);
  assert.equal(graph.nodes.length, LIMITS.refs + 1);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(records.at(-1), {
    proposalId: input.decision.edges[0].proposalId, status: 'skipped', reason: 'reference_limit',
  });
});

test('invalid decisions reject atomically with bounded per-judgment explanations', () => {
  const cases = [
    ['decision_not_compilable', input => { input.decision.status = 'timeout'; }],
    ['invalid_bundle', input => { input.decision.bundle = structuredClone(input.decision.bundle); }],
    ['invalid_event', input => { input.event = { ...input.event, kind: 'tool.requested' }; }],
    ['invalid_event', input => { input.event = null; }],
    ['invalid_judgments', input => { input.decision.nodes = null; }],
    ['invalid_judgments', input => { input.decision.edges = null; }],
    ['invalid_judgments', input => { input.decision.nodes[0].supportProbability = NaN; }],
    ['invalid_judgments', input => { input.decision.edges[0].evidenceCandidateIds = []; }],
    ['duplicate_judgments', input => { input.decision.nodes.push(input.decision.nodes[0]); }],
    ['duplicate_judgments', input => { input.decision.edges[1] = input.decision.edges[0]; }],
    ['judgment_limit', input => { input.decision.nodes = Array(LIMITS.candidates + 1).fill(input.decision.nodes[0]); }],
    ['judgment_limit', input => { input.decision.edges.push(input.decision.edges[0]); }],
  ];
  for (const [reason, invalidate] of cases) {
    const input = fixture();
    invalidate(input);
    const { patch, records } = observe(input);
    assert.equal(patch, null, reason);
    assert.ok(records.length <= LIMITS.candidates + LIMITS.proposals + 1, reason);
    assert.ok(records.every(r => r.status === 'skipped' && r.reason === reason), reason);
    assert.deepEqual(records.at(-1), { status: 'skipped', reason });
    assert.equal(compileDecision(emptyGraph(), input), null, 'audit preserves atomic validation');
  }
});

test('malformed or oversized judgments cannot leak text or exceed 20 outcomes', () => {
  const input = fixture();
  input.decision.nodes = Array(10000).fill({ candidateId: '/private/project/cache.ts SOURCE_BODY_SENTINEL' });
  input.decision.edges = Array(10000).fill({ proposalId: 'PostgreSQL.insert(note)' });
  const { patch, records } = observe(input);
  assert.equal(patch, null);
  assert.equal(records.length, LIMITS.candidates + LIMITS.proposals + 1);
  assert.ok(records.every(r => Object.keys(r).length === 2 && r.reason === 'judgment_limit'));
  assert.doesNotMatch(JSON.stringify(records), /private|cache\.ts|SOURCE_BODY_SENTINEL|PostgreSQL/);

  const forged = fixture();
  forged.decision.nodes[0].candidateId = `source_label-${'a'.repeat(32)}`;
  forged.decision.edges[0].proposalId = `private_token-${'b'.repeat(32)}`;
  const rejected = observe(forged);
  assert.equal(rejected.patch, null);
  assert.doesNotMatch(JSON.stringify(rejected.records), /source_label|private_token/);
});

test('early rejection does not invoke extra getters to construct diagnostics', () => {
  let accessed = 0;
  const decision = { status: 'timeout' };
  Object.defineProperty(decision, 'nodes', { get() { accessed++; throw new Error('do not inspect'); } });
  const { patch, records } = observe({ event, policy, decision });
  assert.equal(patch, null);
  assert.equal(accessed, 0);
  assert.deepEqual(records, [{ status: 'skipped', reason: 'decision_not_compilable' }]);
});

test('empty decisions, all-skipped decisions and unchanged results have distinct summaries', () => {
  const empty = fixture();
  empty.decision.nodes = []; empty.decision.edges = [];
  assert.deepEqual(observe(empty).records, [{ status: 'skipped', reason: 'empty_decision' }]);
  const absent = observe({ event, policy });
  assert.deepEqual(absent.records, [{ status: 'skipped', reason: 'decision_not_compilable' }]);

  const skipped = fixture();
  [...skipped.decision.nodes, ...skipped.decision.edges].forEach(j => { j.supportProbability = 0; });
  assert.deepEqual(observe(skipped).records.at(-1), { status: 'skipped', reason: 'no_drawable_change' });

  const input = fixture();
  const current = observe(input).graph;
  input.decision.edges.forEach(j => { j.supportProbability = 0; });
  assert.deepEqual(observe(input, current).records.at(-1), { status: 'unchanged', reason: 'no_change' });
});

test('revision exhaustion cannot report upserts as added when no patch can be returned', () => {
  const { patch, records } = observe(fixture(), { ...emptyGraph(), revision: Number.MAX_SAFE_INTEGER });
  assert.equal(patch, null);
  assert.ok(records.every(r => r.status === 'skipped' && r.reason === 'revision_limit'));
  assert.deepEqual(records.at(-1), { status: 'skipped', reason: 'revision_limit' });
});

test('audit metadata is fixed, frozen and cannot mutate the graph, event or decision', () => {
  const input = fixture({ artifactCount: 3 });
  const original = structuredClone(input);
  freeze(input);
  const graph = freeze(emptyGraph());
  const records = [], mutationAttempts = [];
  const patch = compileDecision(graph, {
    ...input,
    onDiagnostic(record) {
      records.push(record);
      assert.ok(Object.isFrozen(record));
      for (const key of Object.keys(record)) {
        assert.ok(['candidateId', 'proposalId', 'status', 'reason'].includes(key));
        assert.equal(typeof record[key], 'string');
        if (key.endsWith('Id')) assert.ok(isId(record[key]));
      }
      assert.ok(['added', 'updated', 'unchanged', 'skipped'].includes(record.status));
      assert.ok(reasons.has(record.reason));
      mutationAttempts.push(Reflect.set(record, 'decision', { nodes: [] }));
      mutationAttempts.push(Reflect.set(record, 'reason', 'injected text'));
      mutationAttempts.push(Reflect.deleteProperty(record, 'status'));
    },
  });
  assert.ok(patch);
  assert.equal(records.length, input.decision.nodes.length + input.decision.edges.length);
  assert.ok(mutationAttempts.every(success => success === false));
  assert.deepEqual(input, original);
  assert.deepEqual(graph, emptyGraph());
  assert.deepEqual(patch, compileDecision(graph, input));
  assert.doesNotMatch(JSON.stringify(records), /Unit\d|private|cache-|SOURCE_BODY_SENTINEL|sourceRef|bundle|hash|role|text/);
});

test('throwing and rejected async callbacks cannot alter admission or escape', async () => {
  const input = fixture();
  const expected = compileDecision(emptyGraph(), input);
  let calls = 0;
  const actual = compileDecision(emptyGraph(), {
    ...input, onDiagnostic() { calls++; throw new Error('observer failed'); },
  });
  assert.deepEqual(actual, expected);
  assert.equal(calls, input.decision.nodes.length + input.decision.edges.length);
  const asyncPatch = compileDecision(emptyGraph(), {
    ...input, async onDiagnostic() { throw new Error('async observer failed'); },
  });
  assert.deepEqual(asyncPatch, expected);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(compileDecision(emptyGraph(), { ...input, onDiagnostic: {} }), expected);
});

test('callbacks run only after the patch is complete, including later judgments', () => {
  const input = fixture();
  const expected = compileDecision(emptyGraph(), input);
  const actual = compileDecision(emptyGraph(), {
    ...input,
    onDiagnostic() {
      // An observer holding unrelated caller references still cannot change
      // this compilation's later admissions: all outcomes have been decided.
      input.decision.nodes.forEach(j => { j.supportProbability = 0; });
      input.decision.edges.length = 0;
    },
  });
  assert.deepEqual(actual, expected);
});

test('invalid graph errors retain their contract even when the observer throws', () => {
  const records = [];
  assert.throws(() => compileDecision({ ...emptyGraph(), revision: -1 }, {
    ...fixture(),
    onDiagnostic(record) { records.push(record); throw new Error('observer failed'); },
  }), /INVALID_GRAPH/);
  assert.deepEqual(records, [{ status: 'skipped', reason: 'invalid_graph' }]);
});
