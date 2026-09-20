import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { hash } from '../../runtime/core/common.mjs';
import { materializeBundle } from '../../runtime/core/index.mjs';
import { createPersistence } from '../../runtime/daemon/persistence.mjs';
import { createModelPersistence } from '../../runtime/daemon/model-persistence.mjs';

const policy = { transmitSource: true, displayEvidence: true, persistEvidence: true };
const source = version => `// SYNTHETIC_RESTART_BODY\nexport function syntheticComponent(value) { return value + ${version}; }\n`;

function fixtureService() {
  // Generated source stays in this process. There is no provider or credential.
  let calls = 0;
  return {
    async classify({ candidates, policy }) {
      calls++;
      const bundle = materializeBundle({
        candidates, policy,
        verdicts: candidates.map(candidate => ({
          candidateId: candidate.id, digest: candidate.digest, relevant: 0.99, sensitive: 0.01,
        })),
      });
      return {
        status: 'accepted', bundle, edges: [],
        nodes: bundle.candidates.map(candidate => ({
          candidateId: candidate.id, role: 'module', supportProbability: 0.99,
          roleProbability: 0.99, roleConfidence: 0.95,
          roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
        })),
      };
    },
    stats: () => ({ calls }),
    close() {},
  };
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-restart-generations-')));
  const projectRoot = path.join(directory, 'project'), data = path.join(directory, 'data');
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(data, { mode: 0o700 });
  const filename = path.join(projectRoot, 'component.js');
  const pipelines = new Set(), stores = new Set();
  t.after(async () => {
    try {
      for (const pipeline of pipelines) await pipeline.close();
      for (const store of stores) await store.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  function open(restored = {}) {
    const pipeline = createPipeline({ projectRoot, policy, decisionService: fixtureService(), ...restored });
    pipelines.add(pipeline);
    return pipeline;
  }
  async function inspect(pipeline, id) {
    const result = await pipeline.ingest({
      cwd: projectRoot, hook_event_name: 'PostToolUse', session_id: 'synthetic-restart',
      tool_use_id: id, tool_name: 'Read', tool_input: { file_path: filename },
      tool_response: { success: true },
    });
    assert.equal(result.accepted, true);
    await pipeline.whenIdle();
  }
  async function persist(pipeline) {
    const legacyFile = path.join(data, 'state.json'), modelFile = path.join(data, 'model-state.json');
    const legacy = createPersistence(legacyFile);
    const model = createModelPersistence(modelFile, { projectId: pipeline.getModelState().projectId });
    stores.add(legacy); stores.add(model);
    legacy.schedule(pipeline.getState({ persistent: true }));
    assert.equal(model.schedule(pipeline.getModelState({ persistent: true })), true);
    await Promise.all([legacy.flush(), model.flush()]);
    assert.equal(JSON.parse(await readFile(legacyFile, 'utf8')).schemaVersion, 1);
    assert.equal(JSON.parse(await readFile(modelFile, 'utf8')).schemaVersion, 2);
    const [restoredState, restoredModel] = await Promise.all([legacy.load(), model.load()]);
    assert.ok(restoredState);
    assert.ok(restoredModel);
    assert.equal(JSON.stringify(restoredModel).includes('SYNTHETIC_RESTART_BODY'), false);
    return { restoredState, restoredModel };
  }
  return { filename, open, inspect, persist };
}

function currentVersion(pipeline, text) {
  const snapshot = pipeline.getModelState();
  const artifact = snapshot.coverage.artifacts.find(value => value.relativePath === 'component.js');
  assert.ok(artifact, 'real source capture populated the model artifact');
  assert.equal(artifact.hash, hash(text));
  assert.equal(artifact.fresh, true);
  const parsed = snapshot.entities.filter(value => value.basis === 'parsed' && value.validity !== 'retracted');
  const roles = snapshot.interpretations.filter(value =>
    value.namespace === 'graphlin.legacy-role' && value.label === 'syntheticComponent' && value.validity === 'current');
  assert.ok(parsed.some(value => value.kind === 'function' && value.label === 'syntheticComponent'));
  assert.ok(roles.length > 0, 'a freshly accepted decision is current in the semantic model');
  const nodes = pipeline.getState().graph.nodes.filter(value => value.label === 'syntheticComponent');
  assert.ok(nodes.length > 0, 'a freshly accepted decision is current in the restored legacy session');
  for (const record of [...parsed, ...roles, ...nodes]) {
    assert.equal(record.validity, 'current');
    assert.equal(record.classification, 'accepted');
    assert.ok(record.sourceRefs.length > 0);
    for (const ref of record.sourceRefs) {
      assert.equal(ref.artifactId, artifact.id);
      assert.equal(ref.hash, artifact.hash);
      assert.equal(ref.generation, artifact.generation);
    }
  }
  const certificate = snapshot.coverage.enumerations.find(value => value.artifactId === artifact.id);
  assert.equal(certificate.generation, artifact.generation);
  assert.equal(certificate.hash, artifact.hash);
  assert.equal(certificate.complete, true);
  return artifact;
}

for (const changed of [false, true]) {
  test(`restart refreshes generation-three evidence when source is ${changed ? 'changed while stopped' : 'unchanged'}`,
    { timeout: 15_000 }, async t => {
      const fixture = await workspace(t), first = fixture.open();
      let previousGeneration = 0;
      for (let version = 1; version <= 3; version++) {
        await writeFile(fixture.filename, source(version));
        await fixture.inspect(first, `before-restart-${version}`);
        const observed = currentVersion(first, source(version));
        assert.ok(observed.generation > previousGeneration);
        previousGeneration = observed.generation;
      }
      assert.ok(previousGeneration >= 3);
      const marker = first.createCheckpoint({ label: 'Before restart' });
      const frozen = first.getModelState({ checkpointId: marker.id });
      const saved = await fixture.persist(first);
      const floor = Math.max(...saved.restoredModel.coverage.artifacts.map(value => value.generation));
      assert.equal(floor, previousGeneration);
      await first.close();
      if (changed) await writeFile(fixture.filename, source(4));

      const restarted = fixture.open(saved);
      const stale = restarted.getModelState().entities.filter(value => value.basis === 'parsed');
      assert.ok(stale.length > 0);
      assert.ok(stale.every(value => value.validity === 'stale'));
      assert.ok(restarted.getState().graph.nodes.every(value => value.validity === 'stale'));
      assert.deepEqual(restarted.getModelState({ checkpointId: marker.id }), frozen);

      await fixture.inspect(restarted, 'after-restart');
      const refreshed = currentVersion(restarted, source(changed ? 4 : 3));
      assert.ok(refreshed.generation > floor, 'fresh captures must exceed the saved generation floor');
      assert.deepEqual(restarted.getModelState({ checkpointId: marker.id }), frozen);
      assert.deepEqual(restarted.model.changes(marker.id).creations, []);
    });
}
