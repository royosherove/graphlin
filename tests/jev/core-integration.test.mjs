import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle, buildRelationProposals,
  emptyGraph, compileDecision, applyPatch,
} from '../../runtime/core/index.mjs';
import { createDecisionService, createFixtureTransport } from '../../runtime/jev/index.mjs';
import { syntheticProbes } from './fixtures/synthetic-probes.mjs';

test('default core import materializes real candidates and compiles fixture decisions', async t => {
  const policy = createPolicy({ transmitSource: true, displayEvidence: true });
  const event = metadataEvent({
    kind: 'tool.succeeded', toolCategory: 'edit', outcome: 'succeeded',
    projectId: 'test-project', sessionId: 'test-session', id: 'test-event',
    at: 0, sequence: 1, incomplete: false,
  });
  const text = 'export function saveNote(note) { return PostgreSQL.insert(note); }';
  const candidates = buildCandidates({
    event, policy,
    artifacts: [{
      id: `artifact-${'a'.repeat(32)}`,
      relativePath: 'notes.mjs',
      hash: createHash('sha256').update(text).digest('hex'),
      generation: 1, exists: true, status: 'present', complete: true, text,
    }],
  });
  assert.deepEqual(candidates.map(c => c.label), ['saveNote', 'PostgreSQL']);
  const service = createDecisionService({ fetchImpl: createFixtureTransport({ mode: 'demo' }) });
  t.after(() => service.close());
  const decision = await service.classify({ event, candidates, policy });
  assert.equal(decision.status, 'accepted', JSON.stringify(decision.diagnostics));
  assert.equal(decision.bundle.policyVersion, policy.version);
  assert.deepEqual(decision.bundle.candidates, candidates);
  assert.equal(decision.bundle.readSet.length, 1);
  assert.equal(decision.diagnostics.mode, 'demo');
  assert.equal(decision.diagnostics.questionCounts.B, 19);
  assert.equal(decision.diagnostics.proposalsOmitted, 5);
  assert.ok(decision.edges.some(e => e.relation === 'writes' && e.classification === 'accepted'));
  const graph = emptyGraph();
  const patch = compileDecision(graph, { event, decision, policy });
  assert.ok(patch, 'real core accepts Jev judgments and the exact materialized bundle');
  const compiled = applyPatch(graph, patch);
  assert.equal(compiled.nodes.length, 2);
  assert.ok(compiled.edges.some(e => e.relation === 'writes' && e.classification === 'accepted'));
  assert.ok(compiled.nodes.every(n => n.evidenceState === 'observed'));
});

test('real core preserves public-intent proposals and excludes unrecorded labels', async t => {
  const policy = createPolicy({ transmitSource: true });
  const event = metadataEvent({
    kind: 'intent.observed', toolCategory: 'other', outcome: 'observed',
    projectId: 'test-project', sessionId: 'test-session', id: 'message-event',
    at: 0, sequence: 2, incomplete: false,
  });
  const candidates = buildCandidates({
    event, policy, publicText: 'Propose function saveNote(note) calling PostgreSQL.insert(note).',
  });
  assert.ok(candidates.some(c => c.label === 'saveNote'));
  const service = createDecisionService({
    fetchImpl: createFixtureTransport({ mode: 'demo' }),
    materializeBundle, buildRelationProposals,
  });
  t.after(() => service.close());
  const decision = await service.classify({ event, candidates, policy });
  assert.equal(decision.status, 'accepted', JSON.stringify(decision.diagnostics));
  assert.ok(decision.bundle.candidates.every(c => ['saveNote', 'PostgreSQL'].includes(c.label)));
  assert.ok(decision.bundle.readSet.every(ref => ref.type === 'message' && ref.contentVersion === 2));
  const graph = emptyGraph();
  const patch = compileDecision(graph, { event, decision, policy });
  assert.ok(patch);
  const compiled = applyPatch(graph, patch);
  assert.ok([...compiled.nodes, ...compiled.edges].every(item => item.evidenceState === 'proposed'));
});

test('six synthetic probe sources fit discovery and exact pair proposal budgets without model calls', () => {
  const policy = createPolicy({ transmitSource: true });
  const event = metadataEvent({ kind: 'tool.succeeded', toolCategory: 'edit',
    outcome: 'succeeded', id: 'probe-event', incomplete: false });
  assert.equal(syntheticProbes.length, 6);
  for (const probe of syntheticProbes) {
    const candidates = buildCandidates({
      event, policy, artifacts: [{
        id: `artifact-${'b'.repeat(32)}`, relativePath: `${probe.id}.mjs`,
        hash: createHash('sha256').update(probe.source).digest('hex'),
        generation: 1, exists: true, status: 'present', complete: true, text: probe.source,
      }],
    });
    assert.equal(candidates.length, 2, `${probe.id}: keep the proposed pair inside the bounded queue`);
    // A hypothetical approval is used only to audit static proposal coverage.
    // The actual live runner must obtain A verdicts through createDecisionService.
    const bundle = materializeBundle({
      candidates, policy,
      verdicts: candidates.map(c => ({ candidateId: c.id, digest: c.digest, relevant: 1, sensitive: 0 })),
    });
    const source = candidates.find(c => c.label === probe.sourceLabel);
    const target = candidates.find(c => c.label === probe.targetLabel);
    const { proposals } = buildRelationProposals(bundle, { maxQuestionsPerStage: 40 });
    assert.ok(source && target);
    assert.ok(proposals.some(p => p.sourceCandidateId === source.id
      && p.targetCandidateId === target.id && p.relation === probe.relation),
    `${probe.id}: evaluate the intended directed proposition, not any write`);
    assert.ok(1 + 2 * candidates.length + 2 * proposals.length <= 40);
  }
});
