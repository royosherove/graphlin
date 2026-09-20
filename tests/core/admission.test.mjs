import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle, buildRelationProposals,
  emptyGraph, compileDecision, applyPatch,
} from '../../runtime/core/index.mjs';
import { createDecisionService, createFixtureTransport } from '../../runtime/jev/index.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ id: 'admission-event', kind: 'artifact.changed', incomplete: false });
const text = 'export function saveNote(note) { return PostgreSQL.insert(note); }';
function prepared() {
  const candidates = buildCandidates({
    event, policy, artifacts: [{
      id: `artifact-${'a'.repeat(32)}`, relativePath: 'notes.mjs',
      hash: createHash('sha256').update(text).digest('hex'), generation: 1,
      exists: true, status: 'present', complete: true, text,
    }],
  });
  return { event, policy, candidates };
}
function decision({ nodeSupport = 0.99, edgeSupport = 0.99, classification = 'accepted', status = 'accepted' } = {}) {
  const input = prepared();
  const bundle = materializeBundle({ ...input, verdicts: input.candidates.map(c =>
    ({ candidateId: c.id, digest: c.digest, relevant: 0.99, sensitive: 0.01 })) });
  return {
    status, bundle,
    nodes: bundle.candidates.map(c => ({
      candidateId: c.id, role: 'module', supportProbability: nodeSupport,
      roleProbability: 0.99, roleConfidence: 0.95, roleProbabilities: { module: 0.99, unknown: 0.01 },
      classification,
    })),
    edges: buildRelationProposals(bundle).proposals.map(({ id, ...proposal }) => ({
      ...proposal, proposalId: id, supportProbability: edgeSupport, missingContextProbability: 0.01, classification,
    })),
  };
}
function compile(d) {
  const graph = emptyGraph(), patch = compileDecision(graph, { event, decision: d, policy });
  return patch ? applyPatch(graph, patch) : graph;
}

test('all false judgments cannot create architecture, regardless of classification labels', () => {
  for (const status of ['accepted', 'abstained']) for (const classification of ['accepted', 'tentative']) {
    const d = decision({ nodeSupport: 0.01, edgeSupport: 0.02, status, classification });
    const original = structuredClone(d);
    assert.deepEqual(compile(d), emptyGraph());
    assert.deepEqual(d, original, 'raw judgments are preserved');
  }
});

test('a high-support edge cannot resurrect a node below the support floor', () => {
  const d = decision({ nodeSupport: 0.499, edgeSupport: 0.99 });
  assert.deepEqual(compile(d), emptyGraph());
});

test('unsupported relation alternatives are omitted while supported nodes remain visible', () => {
  for (const support of [0, 0.01, 0.02, 0.499]) {
    const graph = compile(decision({ edgeSupport: support }));
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 0);
  }
});

test('exactly 0.5 support is drawable as tentative, without relaxing accepted-claim thresholds', () => {
  const graph = compile(decision({ nodeSupport: 0.5, edgeSupport: 0.5 }));
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 7);
  assert.ok([...graph.nodes, ...graph.edges].every(item => item.classification === 'tentative'));
  const mixed = decision({ edgeSupport: 0.01 });
  mixed.edges[0].supportProbability = 0.5;
  const mixedGraph = compile(mixed);
  assert.equal(mixedGraph.edges.length, 1);
  assert.equal(mixedGraph.edges[0].classification, 'tentative');
});

test('the offline demo draws only its recorded write and retains raw false alternatives in the decision', async t => {
  const service = createDecisionService({ fetchImpl: createFixtureTransport({ mode: 'demo' }) });
  t.after(() => service.close());
  const d = await service.classify(prepared());
  assert.equal(d.status, 'accepted');
  assert.equal(d.edges.length, 7);
  assert.equal(d.edges.filter(edge => edge.supportProbability < 0.5).length, 6);
  const original = structuredClone(d);
  const graph = compile(d);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relation, 'writes');
  assert.equal(graph.edges[0].classification, 'accepted');
  assert.deepEqual(d, original);
});

test('fixture judgments with known roles but uniformly low node support cannot create architecture', async t => {
  const record = { role: 'module', relevant: 0.99, sensitive: 0.01, support: 0.01 };
  const service = createDecisionService({
    fetchImpl: createFixtureTransport({ mode: 'demo', candidates: { saveNote: record, PostgreSQL: record } }),
  });
  t.after(() => service.close());
  const d = await service.classify(prepared());
  assert.equal(d.status, 'abstained');
  assert.equal(d.nodes.length, 2, 'Jev still records its raw known-role judgments');
  assert.deepEqual(compile(d), emptyGraph());
});
