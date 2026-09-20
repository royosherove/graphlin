import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import {
  createPolicy, materializeBundle, buildRelationProposals, EvidenceStore,
} from '../../runtime/core/index.mjs';

async function workspace(t, sources = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-review-regression-'));
  const pipelines = [];
  t.after(async () => {
    try {
      for (const pipeline of pipelines) await pipeline.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await Promise.all(Object.entries(sources).map(([name, text]) =>
    writeFile(path.join(root, name), text)));
  const now = Date.now();
  return {
    root,
    file: name => path.join(root, name),
    open(options = {}) {
      const pipeline = createPipeline({
        projectRoot: root,
        policy: createPolicy({ transmitSource: true, displayEvidence: true, persistEvidence: false }),
        decisionService: fixtureService(),
        // These regressions exercise ordering, not elapsed-time deadlines.
        clock: () => now,
        ...options,
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  };
}

function tool(paths, id = 'write') {
  return {
    hook_event_name: 'PostToolUse', session_id: 'one', tool_use_id: id,
    tool_name: 'Write', tool_input: { paths }, tool_response: { success: true },
  };
}

function accepted({ candidates, policy }, { crossFileRelation = false } = {}) {
  const bundle = materializeBundle({
    candidates, policy,
    intakePolicy: { version: 'intake-v1', sensitiveMax: 0.1, relevantMin: 0.5 },
    verdicts: candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest, relevant: 0.99, sensitive: 0.01,
    })),
  });
  const edges = [];
  if (crossFileRelation) {
    const byId = new Map(bundle.candidates.map(candidate => [candidate.id, candidate]));
    // A recorded fixture judgment requires both files in the approved bundle.
    // The core supplies the exact proposition and its evidence identities.
    const proposal = buildRelationProposals(bundle).proposals.find(item =>
      item.relation === 'calls' &&
      byId.get(item.sourceCandidateId)?.label === 'alphaModule' &&
      byId.get(item.targetCandidateId)?.label === 'betaModule' &&
      byId.get(item.sourceCandidateId).artifactId !== byId.get(item.targetCandidateId).artifactId);
    if (proposal) {
      const { id, ...fields } = proposal;
      edges.push({
        ...fields, proposalId: id, supportProbability: 0.99,
        missingContextProbability: 0.01, classification: 'accepted',
      });
    }
  }
  return {
    status: 'accepted', activity: 'implement', bundle,
    nodes: bundle.candidates.map(candidate => ({
      candidateId: candidate.id, role: 'module', supportProbability: 0.99,
      roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
    })),
    edges,
    stages: {
      A: { model: 'fixture', rubricVersion: 'intake-v1', inputHash: 'fixture', usage: {}, mode: 'fixture' },
      B: { model: 'fixture', rubricVersion: 'graph-v1', inputHash: 'fixture', usage: {}, mode: 'fixture' },
    },
    diagnostics: {},
  };
}

function fixtureService(classify = input => accepted(input)) {
  let calls = 0;
  return {
    async classify(input) { calls++; return classify(input); },
    stats: () => ({ calls }),
    close() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a full message changing A to B to A advances its version and retracts B', async t => {
  const project = await workspace(t);
  const service = fixtureService();
  const pipeline = project.open({ decisionService: service });
  const message = { hook_event_name: 'PublicMessage', session_id: 'one', message_id: 'same-message' };
  async function publish(label) {
    const receipt = await pipeline.ingest({ ...message, text: `Propose function ${label}() {}` });
    assert.equal(receipt.accepted, true);
    await pipeline.whenIdle();
    return receipt;
  }

  await publish('alphaPlan');
  assert.deepEqual(pipeline.getState().graph.nodes.map(node => node.label), ['alphaPlan']);
  const first = pipeline.getState().graph.nodes[0].sourceRefs[0].sourceRef;
  await publish('betaPlan');
  assert.deepEqual(pipeline.getState().graph.nodes.map(node => node.label), ['betaPlan']);
  const second = pipeline.getState().graph.nodes[0].sourceRefs[0].sourceRef;

  const receipt = await publish('alphaPlan');
  assert.notEqual(receipt.duplicate, true, 'returning to earlier text is a new observed version');
  const graph = pipeline.getState().graph;
  assert.deepEqual(graph.nodes.map(node => node.label), ['alphaPlan']);
  assert.equal(graph.nodes[0].validity, 'current');
  assert.equal(graph.nodes[0].evidenceState, 'proposed');
  for (const ref of graph.nodes[0].sourceRefs) {
    assert.equal(ref.sourceRef.messageId, first.messageId);
    assert.equal(ref.hash, first.hash);
    assert.notEqual(ref.hash, second.hash);
    assert.ok(ref.sourceRef.contentVersion > second.contentVersion);
  }
  const calls = service.stats().calls;
  assert.equal((await publish('alphaPlan')).duplicate, true, 'an immediate retransmission remains deduplicated');
  assert.equal(service.stats().calls, calls);
  assert.equal(pipeline.getState().graph.revision, graph.revision);
});

test('resume refreshes a deferred relationship with fresh support from both files', async t => {
  const alpha = 'export function alphaModule() { return 1; }\n';
  const beta = 'export function betaModule() { return 2; }\n';
  const project = await workspace(t, { 'alpha.js': alpha, 'beta.js': beta });
  const service = fixtureService(input => accepted(input, { crossFileRelation: true }));
  const pipeline = project.open({ decisionService: service });
  await pipeline.ingest(tool([project.file('alpha.js'), project.file('beta.js')]));
  await pipeline.whenIdle();
  const initial = pipeline.getState().graph;
  assert.equal(initial.nodes.length, 2);
  assert.equal(initial.edges.length, 1, 'the actual core proposal produced the fixture relationship');
  const edge = initial.edges[0];
  assert.equal(edge.validity, 'current');
  const priorVersions = new Map(edge.sourceRefs.map(ref => [ref.artifactId, ref]));
  assert.equal(priorVersions.size, 2);

  pipeline.setPaused(true);
  const calls = service.stats().calls;
  await Promise.all([
    writeFile(project.file('alpha.js'), alpha + '// revised alpha\n'),
    writeFile(project.file('beta.js'), beta + '// revised beta\n'),
  ]);
  await pipeline.reconcile();
  assert.equal(pipeline.getState().graph.edges.find(item => item.id === edge.id)?.validity, 'stale');
  assert.equal(service.stats().calls, calls);

  pipeline.setPaused(false);
  await pipeline.whenIdle();
  const current = pipeline.getState().graph;
  assert.equal(current.nodes.length, 2);
  assert.ok(current.nodes.every(node => node.validity === 'current'));
  const refreshed = current.edges.find(item => item.id === edge.id);
  assert.ok(refreshed, 'resume retains the same relationship identity');
  assert.equal(refreshed.validity, 'current', 'refreshing nodes alone does not refresh the relationship');
  assert.equal(refreshed.classification, 'accepted');
  assert.equal(refreshed.sourceRefs.length, 2);
  for (const ref of refreshed.sourceRefs) {
    const prior = priorVersions.get(ref.artifactId);
    assert.ok(prior, 'relationship support still names the original two artifacts');
    assert.ok(ref.generation > prior.generation);
    assert.notEqual(ref.hash, prior.hash);
  }
});

test('restoration preserves an empty revision and its matching historical graph', async t => {
  const source = 'export function removableModule() { return 1; }\n';
  const project = await workspace(t, { 'module.js': source });
  const pipeline = project.open();
  await pipeline.ingest(tool([project.file('module.js')]));
  await pipeline.whenIdle();
  const populatedRevision = pipeline.getState().graph.revision;
  assert.equal(pipeline.getState().graph.nodes.length, 1);
  await rm(project.file('module.js'));
  await pipeline.reconcile();
  await pipeline.whenIdle();
  const saved = JSON.parse(JSON.stringify(pipeline.getState({ persistent: true })));
  assert.deepEqual(saved.graph.nodes, []);
  assert.deepEqual(saved.graph.edges, []);
  assert.ok(saved.graph.revision > populatedRevision);
  assert.ok(saved.history.some(frame => frame.revision === saved.graph.revision));

  const restored = project.open({ restoredState: saved });
  const state = restored.getState();
  assert.ok(state.graph.revision >= saved.graph.revision, 'an empty live graph cannot reset the revision counter');
  assert.deepEqual(state.graph.nodes, []);
  assert.deepEqual(state.graph.edges, []);
  const deletion = state.history.find(frame => frame.revision === saved.graph.revision);
  assert.ok(deletion, 'the deletion revision remains available for replay');
  assert.deepEqual(deletion.graph, saved.graph);
  assert.ok(state.history.every(frame => frame.revision === frame.graph.revision));

  await writeFile(project.file('module.js'), source);
  await restored.ingest(tool([project.file('module.js')], 'recreated'));
  await restored.whenIdle();
  assert.equal(restored.getState().graph.nodes.length, 1);
  assert.ok(restored.getState().graph.revision > saved.graph.revision);
});

test('pausing during the final evidence reread defers acceptance until resume', { concurrency: false }, async t => {
  const project = await workspace(t, { 'module.js': 'export function pauseFixture() { return 1; }\n' });
  const entered = deferred(), release = deferred();
  let armed = false, intercepted = false;
  const original = EvidenceStore.prototype.reconcile;
  const service = fixtureService(input => {
    const result = accepted(input);
    armed = true;
    return result;
  });
  const pipeline = project.open({ decisionService: service });
  const mock = t.mock.method(EvidenceStore.prototype, 'reconcile', async function (...args) {
    if (armed && !intercepted) {
      intercepted = true;
      entered.resolve();
      await release.promise;
    }
    return original.apply(this, args);
  });
  try {
    await pipeline.ingest(tool([project.file('module.js')]));
    await within(entered.promise, 'classification never reached its final evidence reread');
    assert.equal(pipeline.getState().graph.nodes.length, 0);
    pipeline.setPaused(true);
    release.resolve();
    await pipeline.whenIdle();
    assert.equal(pipeline.getState().paused, true);
    assert.equal(pipeline.getState().status.classifier, 'paused');
    assert.equal(pipeline.getState().graph.nodes.length, 0, 'a completed answer cannot bypass a newly applied pause');
    assert.equal(pipeline.getState().status.pending, 0);

    pipeline.setPaused(false);
    await pipeline.whenIdle();
    assert.equal(pipeline.getState().graph.nodes.length, 1, 'the deferred evidence remains eligible after resume');
    assert.equal(pipeline.getState().graph.nodes[0].validity, 'current');
  } finally {
    release.resolve();
    await pipeline.whenIdle();
    mock.mock.restore();
  }
});
