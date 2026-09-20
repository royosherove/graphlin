import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { createPolicy, materializeBundle } from '../../runtime/core/index.mjs';

const source = `import { Pool } from "pg";
const db = new Pool({ connectionString: process.env.DATABASE_URL });
export function saveNote(body) {
  return db.query("INSERT INTO notes (body) VALUES ($1)", [body]);
}
`;

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-integration-'));
  const file = path.join(root, 'notes.js');
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file };
}

function tool(file, { session = 'one', id = 'tool-1', kind = 'PostToolUse', name = 'Write' } = {}) {
  return {
    hook_event_name: kind, session_id: session, tool_use_id: id,
    tool_name: name, tool_input: { file_path: file },
    tool_response: { success: true },
  };
}

function accepted({ candidates, policy }) {
  const bundle = materializeBundle({
    candidates, policy, intakePolicy: { version: 'intake-v1', sensitiveMax: 0.1, relevantMin: 0.5 },
    verdicts: candidates.map(c => ({ candidateId: c.id, digest: c.digest, relevant: 0.99, sensitive: 0.01 })),
  });
  return {
    status: 'accepted', activity: 'implement', bundle,
    nodes: bundle.candidates.map(c => ({
      candidateId: c.id, role: 'module', supportProbability: 0.99,
      roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
    })),
    edges: [],
    stages: {
      A: { model: 'fixture', rubricVersion: 'intake-v1', inputHash: 'fixture', usage: {}, mode: 'fixture' },
      B: { model: 'fixture', rubricVersion: 'graph-v1', inputHash: 'fixture', usage: {}, mode: 'fixture' },
    },
    diagnostics: {},
  };
}

function fixtureService(classify = async input => accepted(input)) {
  let calls = 0;
  return {
    classify: input => { calls++; return classify(input); },
    stats: () => ({ calls }),
    close() {},
  };
}

test('metadata default and pre-tool events cannot create confirmed architecture', async t => {
  const { root, file } = await project(t);
  const service = fixtureService();
  const pipeline = createPipeline({ projectRoot: root, decisionService: service });
  t.after(() => pipeline.close());
  await pipeline.ingest({
    ...tool(file), prompt: 'PRIVATE_SOURCE_FIXTURE', tool_response: { token: 'TOP_SECRET_FIXTURE' },
  });
  await pipeline.whenIdle();
  assert.equal(service.stats().calls, 0);
  const snapshot = pipeline.getState({ persistent: true });
  assert.equal(snapshot.graph.nodes.length, 0);
  assert.equal(snapshot.activity.length, 1);
  assert.equal(snapshot.status.classifier, 'metadata_only');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_SOURCE_FIXTURE|TOP_SECRET_FIXTURE|notes\.js|INSERT INTO/);

  const enabled = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true, displayEvidence: true }),
    decisionService: service,
  });
  t.after(() => enabled.close());
  await enabled.ingest(tool(file, { kind: 'PreToolUse' }));
  await enabled.whenIdle();
  assert.equal(service.stats().calls, 0);
  assert.equal(enabled.getState().graph.nodes.length, 0);
  assert.equal(enabled.getState().activity[0].state, 'pending');
});

test('late requests and duplicate outcomes do not regress completed tool activity', async t => {
  const { root, file } = await project(t);
  const pipeline = createPipeline({ projectRoot: root });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file));
  await pipeline.ingest(tool(file, { kind: 'PreToolUse' }));
  const duplicate = await pipeline.ingest(tool(file));
  assert.equal(duplicate.duplicate, true);
  assert.equal(pipeline.getState().activity.length, 1);
  assert.equal(pipeline.getState().activity[0].state, 'succeeded');
});

test('worktree edits invalidate both sessions while classification is paused; deletion retracts', async t => {
  const { root, file } = await project(t);
  const service = fixtureService();
  const pipeline = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true, displayEvidence: true }),
    decisionService: service,
  });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file, { session: 'one' }));
  await pipeline.whenIdle();
  const first = pipeline.getState().sessionId;
  assert.ok(pipeline.getState().graph.nodes.length > 0, 'source produced grounded nodes');
  await pipeline.ingest(tool(file, { session: 'two', id: 'read-2', name: 'Read' }));
  await pipeline.whenIdle();
  const second = pipeline.getState().sessions.find(s => s.id !== first).id;
  pipeline.selectSession(second);
  assert.ok(pipeline.getState().graph.nodes.length > 0);
  assert.ok(pipeline.getState().graph.nodes.every(n => n.evidenceState !== 'verified'));
  const callCount = service.stats().calls;
  pipeline.setPaused(true);
  await writeFile(file, source.replace('INSERT INTO', 'SELECT * FROM'));
  await pipeline.reconcile();
  for (const id of [first, second]) {
    pipeline.selectSession(id);
    assert.ok(pipeline.getState().graph.nodes.every(n => n.validity === 'stale'));
  }
  assert.equal(service.stats().calls, callCount);
  pipeline.setPaused(false);
  await pipeline.whenIdle();
  assert.ok(service.stats().calls > callCount);
  for (const id of [first, second]) {
    pipeline.selectSession(id);
    assert.ok(pipeline.getState().graph.nodes.every(n => n.validity === 'current'));
  }
  pipeline.setPaused(true);
  await rm(file);
  await pipeline.reconcile();
  for (const id of [first, second]) {
    pipeline.selectSession(id);
    assert.equal(pipeline.getState().graph.nodes.length, 0);
  }
});

test('an old Jev answer cannot revive an artifact edited while classification ran', async t => {
  const { root, file } = await project(t);
  let release;
  let firstInput;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const service = fixtureService(async input => {
    if (!firstInput) {
      firstInput = input;
      start();
      await new Promise(resolve => { release = resolve; });
    }
    return accepted(input);
  });
  const pipeline = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true, displayEvidence: true }),
    decisionService: service,
  });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file));
  await started;
  const oldHash = firstInput.candidates[0].hash;
  await writeFile(file, source.replace('saveNote', 'saveChangedNote'));
  release();
  await pipeline.whenIdle();
  assert.ok(pipeline.getState().status.dropped >= 1, 'stale answer was rejected');
  assert.ok(pipeline.getState().graph.nodes.every(n => n.sourceRefs.every(r => r.hash !== oldHash)));
});

test('restored claims start stale and persistence applies its own content policy', async t => {
  const { root, file } = await project(t);
  const policy = createPolicy({ transmitSource: true, displayEvidence: true, persistEvidence: false });
  const pipeline = createPipeline({ projectRoot: root, policy, decisionService: fixtureService() });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file));
  await pipeline.whenIdle();
  await writeFile(file, source.replace('saveNote', 'saveRevisedNote'));
  await pipeline.ingest(tool(file, { id: 'tool-2' }));
  await pipeline.whenIdle();
  const persisted = pipeline.getState({ persistent: true });
  assert.ok(persisted.graph.nodes.length > 0);
  assert.doesNotMatch(JSON.stringify(persisted), /INSERT INTO|connectionString|process\.env/);
  const restored = createPipeline({
    projectRoot: root, policy, restoredState: persisted, decisionService: fixtureService(),
  });
  t.after(() => restored.close());
  assert.ok(restored.getState().graph.nodes.length > 0);
  assert.ok(restored.getState().graph.nodes.every(n => n.validity === 'stale' && n.evidenceState !== 'verified'));
  assert.ok(persisted.history.length > 1);
  assert.ok(restored.getState().history.length > persisted.history.length);
  for (const historical of persisted.history) {
    assert.ok(restored.getState().history.some(item => item.revision === historical.revision));
  }
});

test('a newer full public message during pause supersedes an in-flight proposal', async t => {
  const { root } = await project(t);
  let release, start, firstInput;
  const started = new Promise(resolve => { start = resolve; });
  const service = fixtureService(async input => {
    if (!firstInput) {
      firstInput = input; start();
      await new Promise(resolve => { release = resolve; });
    }
    return accepted(input);
  });
  const pipeline = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true }), decisionService: service,
  });
  t.after(() => pipeline.close());
  const message = { hook_event_name: 'PublicMessage', session_id: 'session', message_id: 'message' };
  await pipeline.ingest({ ...message, text: 'Propose function oldStorage() {}' });
  await started;
  const oldHash = firstInput.candidates[0].hash;
  pipeline.setPaused(true);
  const replacement = await pipeline.ingest({ ...message, text: 'Propose function revisedStorage() {}' });
  assert.equal(replacement.duplicate, undefined);
  pipeline.setPaused(false);
  release();
  await pipeline.whenIdle();
  assert.ok(pipeline.getState().graph.nodes.length > 0);
  assert.ok(pipeline.getState().graph.nodes.every(node =>
    node.sourceRefs.every(ref => ref.hash !== oldHash)));
});

test('concurrent reconciliation is coalesced into one observation', async t => {
  const { root, file } = await project(t);
  let changes = 0;
  const pipeline = createPipeline({ projectRoot: root, onChange: () => changes++ });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file));
  await writeFile(file, source + '\nexport const added = true;\n');
  changes = 0;
  await Promise.all(Array.from({ length: 100 }, () => pipeline.reconcile()));
  assert.equal(changes, 1);
});

test('acceptance enforces the ingestion deadline independently of the classifier', async t => {
  const { root, file } = await project(t);
  let now = Date.now();
  const service = fixtureService(async input => {
    const result = accepted(input);
    now += 2500;
    return result;
  });
  const pipeline = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true }), decisionService: service,
    clock: () => now,
  });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file));
  await pipeline.whenIdle();
  assert.equal(pipeline.getState().graph.nodes.length, 0);
  assert.equal(pipeline.getState().status.classifier, 'timeout');
});

test('a missing terminal event expires to unresolved without inventing interruption', async t => {
  const { root, file } = await project(t);
  let now = Date.now();
  const pipeline = createPipeline({ projectRoot: root, clock: () => now });
  t.after(() => pipeline.close());
  await pipeline.ingest(tool(file, { kind: 'PreToolUse' }));
  now += 61_000;
  await pipeline.reconcile();
  assert.equal(pipeline.getState().activity[0].state, 'unresolved');
  await pipeline.ingest(tool(file));
  assert.equal(pipeline.getState().activity[0].state, 'succeeded');
});
