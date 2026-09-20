import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { createPolicy, materializeBundle } from '../../runtime/core/index.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const source = 'export function syntheticComponent(value) { return value + 1; }\n';
const lineage = (name, metadata) => ({ id: sha256(`synthetic-lineage:${name}`), ...metadata });
const before = lineage('before', { status: 'git', branch: 'feature/before', head: 'a'.repeat(40) });
const after = lineage('after', { status: 'git', branch: 'feature/after', head: before.head });
const testOptions = { timeout: 15_000 };

function accepted({ candidates, policy }) {
  const bundle = materializeBundle({
    candidates, policy,
    verdicts: candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest, relevant: 0.99, sensitive: 0.01,
    })),
  });
  return {
    status: 'accepted', bundle, edges: [], diagnostics: {},
    nodes: bundle.candidates.map(candidate => ({
      candidateId: candidate.id, role: 'module', supportProbability: 0.99,
      roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
    })),
  };
}

async function fixture(t, { names = ['component'], automatic = true, onDiagnostic } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-lineage-integration-'));
  const calls = [], records = [];
  let pipeline, auto = automatic;
  t.after(async () => {
    try { await pipeline?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await Promise.all(names.map(name => writeFile(path.join(root, `${name}.js`),
    source.replace('syntheticComponent', `${name}Component`))));
  pipeline = createPipeline({
    projectRoot: root,
    policy: createPolicy({ transmitSource: true, displayEvidence: true, persistEvidence: true }),
    classificationDeadlineMs: 10_000,
    onDiagnostic(record) { records.push(record); onDiagnostic?.(record); },
    // Only this in-process fake receives generated source. No provider or credentials are used.
    decisionService: {
      classify(input) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const call = { input, settled: false, result: null, release() {
          if (call.settled) return;
          call.result = accepted(input);
          call.settled = true;
          resolve(call.result);
        } };
        calls.push(call);
        if (auto) call.release();
        // Deliberately ignore AbortSignal: late providers must still be harmless.
        return promise;
      },
      stats: () => ({ calls: calls.length }),
      close() { calls.forEach(call => call.release()); },
    },
  });
  return {
    root, pipeline, calls, records,
    projectId: sha256(await realpath(root)),
    setAutomatic(value) { auto = value; },
    read: (id, { incomplete = false, name = names[0] } = {}) => pipeline.ingest({
      cwd: root, hook_event_name: 'PostToolUse', session_id: 'synthetic-session',
      tool_use_id: id, tool_name: 'Read', incomplete,
      tool_input: { file_path: path.join(root, `${name}.js`) }, tool_response: { success: true },
    }),
  };
}

function oneVersion(candidates) {
  assert.ok(candidates.length > 0, 'the injected provider received actual pipeline candidates');
  const versions = [...new Map(candidates.map(candidate => [candidate.artifactId, {
    artifactId: candidate.artifactId, hash: candidate.hash, generation: candidate.generation,
  }])).values()];
  assert.equal(versions.length, 1);
  return versions[0];
}

function assertCurrent(snapshot, version) {
  const parsed = snapshot.entities.filter(entity => entity.basis === 'parsed');
  assert.ok(parsed.length > 0, 'the actual local parser produced structure');
  const roles = snapshot.interpretations.filter(value => value.namespace === 'graphlin.legacy-role');
  assert.ok(roles.length > 0, 'the current provider answer produced interpretations');
  for (const record of [...parsed, ...roles]) {
    assert.equal(record.validity, 'current');
    assert.ok(record.sourceRefs.length > 0);
    assert.ok(record.sourceRefs.every(ref => ref.artifactId === version.artifactId &&
      ref.hash === version.hash && ref.generation === version.generation));
  }
  const artifact = snapshot.coverage.artifacts.find(value => value.id === version.artifactId);
  assert.equal(artifact.status, 'present');
  assert.equal(artifact.generation, version.generation);
  assert.equal(artifact.fresh, true);
  const certificate = snapshot.coverage.enumerations.find(value => value.artifactId === version.artifactId);
  assert.equal(certificate.generation, version.generation);
  assert.equal(certificate.complete, true);
}

test('late old provider response cannot revive a previous branch after identical-byte recapture', testOptions, async t => {
  const f = await fixture(t);
  const { pipeline } = f;
  await pipeline.observeLineage(before);
  // Incomplete then complete observations require independent decisions over identical bytes.
  await f.read('baseline', { incomplete: true });
  await pipeline.whenIdle();
  assert.equal(f.calls.length, 1);
  const oldVersion = oneVersion(f.calls[0].input.candidates);
  assertCurrent(pipeline.getModelState(), oldVersion);
  const marker = pipeline.createCheckpoint({ label: 'Before branch switch' });
  const frozen = pipeline.getModelState({ checkpointId: marker.id });
  assert.equal(frozen.projectId, f.projectId);
  assert.deepEqual(frozen.coverage.lineage, before);
  const file = path.join(f.root, 'component.js');
  const bytesBefore = await readFile(file), statBefore = await stat(file);

  f.setAutomatic(false);
  await f.read('complete-old-branch');
  assert.equal(f.calls.length, 2);
  const old = f.calls[1];
  assert.deepEqual(oneVersion(old.input.candidates), oldVersion);
  await pipeline.observeLineage(after);
  assert.equal(old.input.signal.aborted, true);
  assert.equal(old.settled, false, 'cancellation does not require a cooperative provider');
  const invalidated = pipeline.getModelState();
  assert.deepEqual(invalidated.coverage.lineage, after);
  assert.ok(invalidated.entities.filter(value => value.basis === 'parsed').every(value => value.validity === 'stale'));
  assert.ok(invalidated.interpretations.every(value => value.validity === 'stale'));
  assert.ok(invalidated.coverage.enumerations.every(value => !value.complete));
  assert.equal(invalidated.coverage.artifacts[0].status, 'unavailable');
  assert.ok(pipeline.getState().graph.nodes.length > 0, 'legacy evidence survives as stale metadata');
  assert.ok(pipeline.getState().graph.nodes.every(value => value.validity === 'stale'));
  await pipeline.whenIdle();
  assert.equal(pipeline.getState().status.pending, 0);

  f.setAutomatic(true);
  await pipeline.reconcile();
  await pipeline.whenIdle();
  assert.equal(f.calls.length, 3);
  const newVersion = oneVersion(f.calls[2].input.candidates);
  assert.deepEqual(newVersion, { ...oldVersion, generation: oldVersion.generation + 1 });
  assertCurrent(pipeline.getModelState(), newVersion);
  assert.ok(pipeline.getState().graph.nodes.every(value => value.validity === 'current' &&
    value.evidenceState !== 'verified' && value.sourceRefs.every(ref => ref.generation === newVersion.generation)));
  const current = pipeline.getModelState(), graph = pipeline.getState().graph;
  old.release();
  assert.equal(old.result.status, 'accepted', 'the late answer was drawable, not an empty failure');
  await tick();
  await pipeline.whenIdle();
  assert.deepEqual(pipeline.getModelState(), current);
  assert.deepEqual(pipeline.getState().graph, graph);
  assert.ok(f.records.some(record => record.eventId === old.input.event.id &&
    record.reason === 'source_changed_during_classification'));
  assert.ok(!f.records.some(record => record.eventId === old.input.event.id && record.stage === 'apply'));
  assert.deepEqual(pipeline.getModelState({ checkpointId: marker.id }), frozen);
  assert.deepEqual(await readFile(file), bytesBefore);
  const statAfter = await stat(file);
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
  assert.equal(statAfter.ino, statBefore.ino);
});

test('a returned old answer is rejected when the serialized lineage change precedes its application', testOptions, async t => {
  let f, switching, oldId;
  f = await fixture(t, { automatic: false, onDiagnostic(record) {
    if (record.eventId === oldId && record.stage === 'classification' && record.status === 'accepted') {
      // Completion has won Promise.race. Queue a lineage observation before local acceptance.
      switching = f.pipeline.observeLineage(after);
    }
  } });
  await f.pipeline.observeLineage(before);
  await f.read('old-answer');
  assert.equal(f.calls.length, 1);
  const old = f.calls[0], oldVersion = oneVersion(old.input.candidates);
  oldId = old.input.event.id;
  old.release();
  await f.pipeline.whenIdle();
  assert.ok(switching, 'the injected ordering occurred after the provider returned');
  await switching;
  assert.equal(old.result.status, 'accepted');
  assert.deepEqual(f.pipeline.getModelState().coverage.lineage, after);
  assert.equal(f.pipeline.getState().graph.nodes.length, 0);
  assert.equal(f.pipeline.getModelState().interpretations.length, 0);
  assert.ok(f.records.some(record => record.eventId === oldId && record.reason === 'source_changed_during_classification'));
  assert.ok(!f.records.some(record => record.eventId === oldId && record.stage === 'apply'));
  f.setAutomatic(true);
  await f.pipeline.reconcile();
  await f.pipeline.whenIdle();
  assert.equal(f.calls.length, 2);
  assertCurrent(f.pipeline.getModelState(), { ...oldVersion, generation: oldVersion.generation + 1 });
});

test('branch changes cancel both active and queued old jobs without leaking pending work', testOptions, async t => {
  const f = await fixture(t, { names: ['alpha', 'beta', 'gamma'], automatic: false });
  await f.pipeline.observeLineage(before);
  await f.pipeline.ingest({ cwd: f.root, hook_event_name: 'SessionStart', session_id: 'synthetic-session' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.pipeline.getState().status.pending, 3);
  const oldJobs = f.records.filter(record => record.reason === 'classification_queued').map(record => record.eventId);
  assert.equal(oldJobs.length, 3);
  const oldCalls = f.calls.slice();
  await f.pipeline.observeLineage(after);
  await f.pipeline.whenIdle();
  assert.equal(f.calls.length, 2, 'the waiting old job never reached the provider');
  assert.ok(oldCalls.every(call => call.input.signal.aborted && !call.settled));
  assert.equal(f.pipeline.getState().status.pending, 0);
  for (const eventId of oldJobs) {
    assert.ok(f.records.some(record => record.eventId === eventId && record.reason === 'source_changed_during_classification'));
  }
  // An actual authorized capture can refresh knownArtifacts before reconciliation,
  // including through a parser revalidation. Reproduce that ordering without sleeps.
  await f.pipeline.ingest({
    cwd: f.root, hook_event_name: 'PreToolUse', session_id: 'synthetic-session',
    tool_use_id: 'recapture-before-reconcile', tool_name: 'Read',
    tool_input: { file_path: path.join(f.root, 'alpha.js') },
  });
  await f.pipeline.whenIdle();
  assert.equal(f.calls.length, 2, 'pre-tool intent itself does not dispatch a provider decision');
  assert.ok(f.pipeline.getModelState().coverage.artifacts.some(value =>
    value.relativePath === 'alpha.js' && value.generation === 2 && value.fresh));
  f.setAutomatic(true);
  await f.pipeline.reconcile();
  await f.pipeline.whenIdle();
  const current = f.pipeline.getModelState();
  assert.deepEqual(current.coverage.lineage, after);
  assert.ok(f.calls.length > oldCalls.length, 'new lineage work is admitted after cancellation');
  assert.equal(current.coverage.artifacts.length, 3);
  assert.ok(current.coverage.artifacts.every(value => value.generation === 2 && value.fresh));
  assert.deepEqual(current.interpretations.map(value => value.label).sort(), ['alphaComponent', 'betaComponent', 'gammaComponent']);
  assert.ok(current.interpretations.every(value => value.validity === 'current' &&
    value.sourceRefs.every(ref => ref.generation === 2)));
  oldCalls.forEach(call => call.release());
  await tick();
  await f.pipeline.whenIdle();
  assert.deepEqual(f.pipeline.getModelState(), current);
  assert.equal(f.pipeline.getState().status.pending, 0);
  assert.ok(!f.records.some(record => oldJobs.includes(record.eventId) && record.stage === 'apply'));
});

test('identical-byte generation follows lineage transitions, including repeats and returning to an old branch', testOptions, async t => {
  const f = await fixture(t);
  const { pipeline } = f;
  await pipeline.observeLineage(before);
  await f.read('initial');
  await pipeline.whenIdle();
  let version = oneVersion(f.calls[0].input.candidates);
  const marker = pipeline.createCheckpoint({ label: 'Original branch' });
  const frozen = pipeline.getModelState({ checkpointId: marker.id });
  const transitions = [
    before, after,
    lineage('new-head', { status: 'git', branch: after.branch, head: 'b'.repeat(40) }),
    lineage('new-head', { status: 'git', branch: after.branch, head: 'b'.repeat(40) }),
    before,
    lineage('unavailable', { status: 'unavailable' }),
    lineage('not-git', { status: 'not_git' }),
    lineage('sha256-head', { status: 'git', head: 'c'.repeat(64) }),
  ];
  let previous = before;
  for (const next of transitions) {
    const changed = previous.id !== next.id;
    const callsBefore = f.calls.length;
    const prior = pipeline.getModelState();
    await pipeline.observeLineage(next);
    const observed = pipeline.getModelState();
    assert.deepEqual(observed.coverage.lineage, next);
    if (changed) {
      assert.ok(observed.entities.filter(value => value.basis === 'parsed').every(value => value.validity === 'stale'));
      assert.ok(observed.interpretations.every(value => value.validity === 'stale'));
    } else assert.deepEqual(observed, prior, 'repeated lineage metadata does not invalidate evidence');
    await pipeline.reconcile();
    await pipeline.whenIdle();
    // An equivalent Read also checks the completed-decision cache within this lineage.
    await f.read(`read-${callsBefore}-${next.id}`);
    await pipeline.whenIdle();
    assert.equal(f.calls.length, callsBefore + Number(changed));
    version = { ...version, generation: version.generation + Number(changed) };
    assert.deepEqual(oneVersion(f.calls.at(-1).input.candidates), version);
    assertCurrent(pipeline.getModelState(), version);
    assert.deepEqual(pipeline.getModelState({ checkpointId: marker.id }), frozen);
    previous = next;
  }
  assert.equal(pipeline.getState().status.pending, 0);
  assert.equal(pipeline.getModelState().projectId, f.projectId);
  assert.equal(await readFile(path.join(f.root, 'component.js'), 'utf8'), source.replace('syntheticComponent', 'componentComponent'));
});
