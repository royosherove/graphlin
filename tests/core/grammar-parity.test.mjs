import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle, buildRelationProposals,
  compileDecision, emptyGraph, applyPatch,
} from '../../runtime/core/index.mjs';
import { ROLES, ROLE_SHAPES, SHAPES, hash, opaque } from '../../runtime/core/common.mjs';
import { ROLES as JEV_ROLES, buildGraphRequest, buildIntakeRequest } from '../../runtime/jev/questions.mjs';
import { normalizeGraph } from '../../runtime/web/app.js';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ id: 'parity-event', kind: 'artifact.changed', incomplete: false });
const text = 'export interface WidgetPort { send(): void; }';
const candidates = buildCandidates({ event, policy, artifacts: [{
  id: opaque('artifact', 'parity.ts'), relativePath: 'parity.ts', text, hash: hash(text), generation: 1,
  complete: true, exists: true, status: 'present',
}] });
const bundle = materializeBundle({ candidates, policy,
  verdicts: candidates.map(c => ({ candidateId: c.id, digest: c.digest, relevant: 1, sensitive: 0 })) });
const decision = { status: 'accepted', bundle, nodes: [{
  candidateId: candidates[0].id, role: 'interface', supportProbability: 0.99, roleProbability: 0.99,
  roleConfidence: 0.95, roleProbabilities: { interface: 0.99, unknown: 0.01 }, classification: 'accepted',
}], edges: [] };
const seed = applyPatch(emptyGraph(), compileDecision(emptyGraph(), { event, decision, policy })).nodes[0];

test('Jev role Choice and core share twelve kinds plus unknown with unchanged question counts', () => {
  assert.deepEqual(new Set(JEV_ROLES), new Set([...ROLES, 'unknown']));
  const a = buildIntakeRequest('fixture', event, candidates);
  const proposals = buildRelationProposals(bundle).proposals;
  const b = buildGraphRequest('fixture', event, bundle, proposals);
  assert.equal(Object.keys(a.questions).length, 1 + a.state.evidence.length + candidates.length);
  assert.equal(Object.keys(b.questions).length, 1 + 2 * candidates.length + 2 * proposals.length);
  assert.deepEqual(new Set(Object.keys(b.questions.b_role_0.criteria)), new Set([...ROLES, 'unknown']));
});

test('viewer preserves every core kind and uses the same shape fallback mapping', () => {
  const nodes = ROLES.map(kind => ({ ...seed, id: opaque('node', 'kind', kind), kind, shape: 'unspecified' }));
  const input = { schemaVersion: 1, revision: 12, nodes, edges: [] };
  const original = structuredClone(input);
  const normalized = normalizeGraph(input);
  assert.equal(normalized.revision, 12);
  assert.deepEqual(normalized.nodes.map(n => [n.kind, n.shape]), ROLES.map(kind => [kind, ROLE_SHAPES[kind]]));
  assert.deepEqual(input, original);
  assert.deepEqual(normalized.nodes.map(n => n.sourceRefs), nodes.map(n => n.sourceRefs));
});

test('viewer preserves all fifteen allowed shapes, including legacy combinations', () => {
  const nodes = SHAPES.map(shape => ({ ...seed, id: opaque('node', 'shape', shape), kind: 'module', shape }));
  const graph = normalizeGraph({ schemaVersion: 1, revision: 1, nodes, edges: [] });
  assert.deepEqual(graph.nodes.map(n => n.shape), SHAPES);
});
