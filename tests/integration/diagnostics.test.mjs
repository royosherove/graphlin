import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { createPolicy, materializeBundle } from '../../runtime/core/index.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-log-pipeline-'));
  const file = path.join(root, 'cache.ts');
  await writeFile(file, 'export function getCachedGreeting() { return "SOURCE_BODY_SENTINEL"; }\n');
  const records = [];
  const service = {
    async classify({ candidates, policy }) {
      const bundle = materializeBundle({
        candidates, policy,
        verdicts: candidates.map(c => ({
          candidateId: c.id, digest: c.digest, relevant: 0.99, sensitive: 0.01,
        })),
      });
      return {
        status: 'accepted', bundle, edges: [],
        nodes: bundle.candidates.map(c => ({
          candidateId: c.id, role: 'function', supportProbability: 0.99,
          roleProbability: 0.99, roleConfidence: 0.95,
          roleProbabilities: { function: 0.99, unknown: 0.01 }, classification: 'accepted',
        })),
        diagnostics: { code: 'ok', calls: 2, durationMs: 30 },
      };
    },
    close() {},
  };
  const pipeline = createPipeline({
    projectRoot: root, policy: createPolicy({ transmitSource: true }),
    decisionService: service, onDiagnostic: record => records.push(record), ...options,
  });
  t.after(async () => { await pipeline.close(); await rm(root, { recursive: true, force: true }); });
  const event = (kind = 'PostToolUse', id = 'write-1') => ({
    cwd: root, hook_event_name: kind, session_id: 'debug-session',
    tool_use_id: id, tool_name: 'Write', tool_input: { file_path: file },
    tool_response: { success: true },
  });
  return { root, file, pipeline, records, event };
}

test('classification log correlates observed file, selected candidates, result and applied shapes', async t => {
  const { pipeline, records, event, root } = await setup(t);
  const receipt = await pipeline.ingest(event());
  await pipeline.whenIdle();
  const capture = records.find(r => r.stage === 'capture');
  const extraction = records.find(r => r.stage === 'candidates');
  const started = records.find(r => r.stage === 'classification' && r.status === 'started');
  const classified = records.find(r => r.stage === 'classification' && r.status === 'accepted');
  const applied = records.find(r => r.stage === 'apply');
  assert.equal(capture.eventId, receipt.eventId);
  assert.equal(extraction.sourceEventId, receipt.eventId);
  assert.equal(classified.eventId, started.eventId);
  assert.equal(applied.eventId, classified.eventId);
  assert.equal(classified.artifacts[0].path, 'cache.ts');
  assert.ok(classified.candidates.some(c => c.label === 'getCachedGreeting'));
  assert.equal(classified.diagnostics.calls, 2);
  assert.ok(applied.patch.nodesAdded > 0);
  assert.equal(applied.patch.nodesAdded, pipeline.getState().graph.nodes.length);
  assert.ok(applied.diagnostics.admission.some(r => r.status === 'added'));
  assert.doesNotMatch(JSON.stringify(records), /SOURCE_BODY_SENTINEL|tool_input|tool_response/);
  assert.ok(!JSON.stringify(records).includes(root));
});

test('pre-tool, duplicate and no-candidate events have explicit skip reasons', async t => {
  const { pipeline, records, event } = await setup(t);
  await pipeline.ingest(event('PreToolUse'));
  assert.ok(records.some(r => r.reason === 'tool_request_has_no_source_outcome'));
  await pipeline.ingest(event());
  await pipeline.whenIdle();
  await pipeline.ingest(event());
  assert.ok(records.some(r => r.reason === 'duplicate_event'));
  await pipeline.ingest({ hook_event_name: 'Stop', session_id: 'debug-session' });
  assert.ok(records.some(r => r.stage === 'skip' && r.reason === 'no_candidates'));
});

test('withheld source is explained locally without sending or logging its content', async t => {
  let calls = 0;
  const { pipeline, records, file, event } = await setup(t, {
    decisionService: { classify() { calls++; throw new Error('should not call'); }, close() {} },
  });
  await writeFile(file, 'const password = "SECRET_VALUE_SENTINEL";\n');
  await pipeline.ingest(event());
  await pipeline.whenIdle();
  assert.equal(calls, 0);
  assert.ok(records.some(r => r.artifacts?.some(a => a.reason === 'source_withheld')));
  assert.doesNotMatch(JSON.stringify(records), /SECRET_VALUE_SENTINEL|password/);
});

test('metadata-only and hidden-evidence logging omit names and labels', async t => {
  for (const policy of [createPolicy(), createPolicy({ transmitSource: true, displayEvidence: false })]) {
    const { pipeline, records, event } = await setup(t, { policy });
    await pipeline.ingest(event());
    await pipeline.whenIdle();
    assert.doesNotMatch(JSON.stringify(records), /cache\.ts|getCachedGreeting|SOURCE_BODY_SENTINEL/);
  }
});

test('diagnostic observer failures cannot prevent a graph update', async t => {
  const { pipeline, event } = await setup(t, {
    onDiagnostic() { throw new Error('broken log observer'); },
  });
  await pipeline.ingest(event());
  await pipeline.whenIdle();
  assert.ok(pipeline.getState().graph.nodes.length > 0);
});

test('no-shape classifier outcomes retain failure diagnostics and apply skip', async t => {
  const { pipeline, records, event } = await setup(t, {
    decisionService: {
      async classify() {
        return { status: 'timeout', diagnostics: { code: 'deadline_exceeded', calls: 1,
          trace: { requests: [{ stage: 'A', status: 'timeout', code: 'deadline_exceeded' }] } } };
      },
      close() {},
    },
  });
  await pipeline.ingest(event());
  await pipeline.whenIdle();
  const failure = records.find(r => r.stage === 'classification' && r.status === 'timeout');
  assert.equal(failure.reason, 'deadline_exceeded');
  assert.equal(failure.artifacts[0].path, 'cache.ts');
  assert.equal(failure.diagnostics.calls, 1);
  assert.ok(records.some(r => r.reason === 'classification_not_drawable'));
  assert.equal(pipeline.getState().graph.nodes.length, 0);
});

test('queued results invalidated by source edits are explained rather than applied', async t => {
  let finish;
  let pendingInput;
  const { pipeline, records, event, file } = await setup(t, {
    decisionService: {
      classify(input) { pendingInput = input; return new Promise(resolve => { finish = resolve; }); },
      close() {},
    },
  });
  await pipeline.ingest(event());
  assert.ok(finish);
  const { candidates, policy } = pendingInput;
  const bundle = materializeBundle({ candidates, policy,
    verdicts: candidates.map(c => ({ candidateId: c.id, digest: c.digest, relevant: 0.99, sensitive: 0.01 })) });
  await writeFile(file, 'export function replacementCache() { return null; }\n');
  finish({ status: 'accepted', bundle, nodes: [], edges: [], diagnostics: { code: 'ok' } });
  await pipeline.whenIdle();
  assert.ok(records.some(r => r.reason === 'source_changed_during_classification'));
  assert.equal(pipeline.getState().graph.nodes.length, 0);
});
