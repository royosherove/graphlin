import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import {
  createPolicy, materializeBundle, buildRelationProposals, EvidenceStore,
} from '../../runtime/core/index.mjs';

function judgment({ candidates, policy }, status = 'accepted') {
  const bundle = materializeBundle({
    candidates, policy,
    verdicts: candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest,
      relevant: status === 'irrelevant' ? 0.01 : 0.99, sensitive: 0.01,
    })),
  });
  return {
    status, bundle, edges: [],
    nodes: status !== 'accepted' ? [] : bundle.candidates.map(candidate => ({
      candidateId: candidate.id, role: 'module', supportProbability: 0.99,
      roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
    })),
    diagnostics: { code: 'ok' },
  };
}

function linkedJudgment(input) {
  const result = judgment(input);
  const candidates = new Map(result.bundle.candidates.map(candidate => [candidate.id, candidate]));
  const proposal = buildRelationProposals(result.bundle).proposals.find(item =>
    item.relation === 'calls' &&
    candidates.get(item.sourceCandidateId)?.label === 'alphaModule' &&
    candidates.get(item.targetCandidateId)?.label === 'betaModule');
  if (proposal) {
    const { id, ...fields } = proposal;
    result.edges.push({
      ...fields, proposalId: id, supportProbability: 0.99,
      missingContextProbability: 0.01, classification: 'accepted',
    });
  }
  return result;
}

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected local queue progress');
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function workspace(t, files, classify, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-discovery-queue-'));
  await Promise.all(Object.entries(files).map(([name, content]) =>
    writeFile(path.join(root, name), content)));
  let now = Date.now();
  const calls = [];
  const records = [];
  const pipeline = createPipeline({
    projectRoot: root, clock: () => now,
    policy: createPolicy({ transmitSource: true, displayEvidence: true }),
    onDiagnostic: record => records.push(record),
    decisionService: {
      classify(input) {
        const call = { input, at: now };
        calls.push(call);
        return classify ? classify(input, call, calls.length) : judgment(input);
      },
      stats: () => ({ calls: calls.length }),
      close() {},
    },
    ...options,
  });
  t.after(async () => {
    await pipeline.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, pipeline, calls, records,
    advance: milliseconds => { now += milliseconds; },
    read: (name, id = name, session = 'orientation') => pipeline.ingest({
      cwd: root, hook_event_name: 'PostToolUse', session_id: session,
      tool_name: 'Read', tool_use_id: id, tool_input: { file_path: path.join(root, name) },
      tool_response: { success: true },
    }),
    start: (session = 'orientation') => pipeline.ingest({
      cwd: root, hook_event_name: 'SessionStart', session_id: session,
    }),
  };
}

function gated(input, call) {
  const pending = gate();
  call.release = () => pending.resolve(judgment(input));
  return pending.promise;
}

test('orientation drains a burst of unchanged files with fresh dispatch deadlines and no duplicate reads', async t => {
  const names = ['server', 'index', 'auth', 'db', 'cache', 'imageStorage', 'router'];
  const project = await workspace(t, Object.fromEntries(names.map(name =>
    [`${name}.ts`, `export function ${name}Component() { return 1; }\n`])), gated);
  const { pipeline, calls, records } = project;
  // The daemon may have seen the worktree before Claude opens this session.
  await pipeline.reconcile();
  assert.equal(calls.length, 0);
  await project.start();
  await Promise.all(names.map(name => project.read(`${name}.ts`)));
  assert.equal(calls.length, 2);
  assert.equal(pipeline.getState().status.pending, names.length, 'pending includes the five waiting files');
  assert.ok(records.some(record => record.reason === 'source_version_pending'));
  const firstDispatch = calls[0].at;
  let completed = 0;
  while (completed < names.length) {
    const batch = calls.slice(completed);
    assert.ok(batch.length > 0 && batch.length <= 2);
    project.advance(1500);
    for (const call of batch) call.release();
    completed += batch.length;
    await until(() => pipeline.getState().status.pending === names.length - completed &&
      calls.length >= Math.min(completed + 2, names.length));
  }
  await pipeline.whenIdle();
  assert.equal(calls.length, names.length);
  assert.ok(calls.at(-1).at > firstDispatch + 2000, 'later files begin after the original deadline');
  assert.ok(calls.every(call => call.input.deadlineAt === call.at + 2000));
  assert.ok(calls.every(call => call.input.event.kind === 'artifact.changed'));
  assert.equal(new Set(calls.flatMap(call => call.input.candidates.map(c => c.artifactId))).size, names.length);
  const state = pipeline.getState();
  assert.equal(state.status.pending, 0);
  assert.equal(state.status.dropped, 0);
  assert.deepEqual(state.graph.nodes.map(node => node.label).sort(), names.map(name => `${name}Component`).sort());
  assert.ok(state.graph.nodes.every(node => node.evidenceState === 'observed'), 'reading source does not verify runtime behavior');
  assert.ok(records.some(record => record.reason === 'classification_started' &&
    record.diagnostics?.queue?.waitMs >= 3000));
});

test('the discovery tail beyond the first 32 paths receives its own candidate budget', async t => {
  const names = Array.from({ length: 40 }, (_, index) => `module${String(index).padStart(2, '0')}`);
  const project = await workspace(t, Object.fromEntries(names.map(name =>
    [`${name}.ts`, `export function ${name}() { return 1; }\n`])));
  await project.start();
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, names.length);
  assert.equal(project.pipeline.getState().graph.nodes.length, names.length);
  assert.ok(project.calls.every(call => new Set(call.input.candidates.map(candidate => candidate.artifactId)).size === 1));
});

test('completed accepted, abstained, and irrelevant versions are deduplicated only within their session', async t => {
  for (const status of ['accepted', 'abstained', 'irrelevant']) {
    const project = await workspace(t, { 'cache.ts': 'export function readCache() { return 1; }\n' },
      input => judgment(input, status));
    await project.read('cache.ts', 'first');
    await project.pipeline.whenIdle();
    await project.read('cache.ts', 'again');
    await project.pipeline.whenIdle();
    assert.equal(project.calls.length, 1, `${status} completion is remembered`);
    assert.ok(project.records.some(record => record.reason === 'source_version_completed'));
    await project.start('another-session');
    await project.pipeline.whenIdle();
    assert.equal(project.calls.length, 2, 'global artifact observation cannot suppress a new session');
  }
});

test('a complete Read promotes the same evidence after an incomplete classification completed', async t => {
  const project = await workspace(t, { 'cache.ts': 'export function cacheComponent() {}\n' });
  await project.pipeline.ingest({
    cwd: project.root, hook_event_name: 'PostToolUse', session_id: 'orientation',
    tool_name: 'Read', tool_use_id: 'incomplete-read', incomplete: true,
    tool_input: { file_path: path.join(project.root, 'cache.ts') }, tool_response: { success: true },
  });
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 1);
  assert.equal(project.pipeline.getState().graph.nodes[0].classification, 'tentative');
  await project.read('cache.ts', 'complete-read');
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 2, 'capture completeness changes the classification input');
  assert.deepEqual(project.calls[0].input.candidates.map(candidate => candidate.digest),
    project.calls[1].input.candidates.map(candidate => candidate.digest), 'source evidence itself is unchanged');
  assert.equal(project.pipeline.getState().graph.nodes[0].classification, 'accepted');
  await project.read('cache.ts', 'complete-read-again');
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 2, 'repeated complete observations remain deduplicated');
});

test('an incomplete classification still in flight cannot suppress a complete Read of the same evidence', async t => {
  const project = await workspace(t, { 'cache.ts': 'export function cacheComponent() {}\n' }, gated);
  await project.pipeline.ingest({
    cwd: project.root, hook_event_name: 'PostToolUse', session_id: 'orientation',
    tool_name: 'Read', tool_use_id: 'incomplete-read', incomplete: true,
    tool_input: { file_path: path.join(project.root, 'cache.ts') }, tool_response: { success: true },
  });
  await project.read('cache.ts', 'complete-read');
  assert.equal(project.calls.length, 2, 'the pending keys distinguish complete and incomplete capture');
  assert.equal(project.pipeline.getState().status.pending, 2);
  assert.equal(project.calls[0].input.event.incomplete, true);
  assert.equal(project.calls[1].input.event.incomplete, false);
  assert.deepEqual(project.calls[0].input.candidates.map(candidate => candidate.digest),
    project.calls[1].input.candidates.map(candidate => candidate.digest));
  project.calls[0].release();
  await until(() => project.pipeline.getState().status.pending === 1);
  assert.equal(project.pipeline.getState().graph.nodes[0].classification, 'tentative');
  project.calls[1].release();
  await project.pipeline.whenIdle();
  assert.equal(project.pipeline.getState().graph.nodes[0].classification, 'accepted');
  assert.equal(project.pipeline.getState().status.pending, 0);
});

test('timeout and unavailable results leave unchanged source eligible for another observation', async t => {
  const outcomes = ['timeout', 'unavailable', 'accepted'];
  const project = await workspace(t, { 'cache.ts': 'export function readCache() { return 1; }\n' },
    input => {
      const status = outcomes.shift();
      return status === 'accepted' ? judgment(input) : { status, diagnostics: {} };
    });
  for (const id of ['timeout', 'unavailable', 'success']) {
    await project.read('cache.ts', id);
    await project.pipeline.whenIdle();
  }
  assert.equal(project.calls.length, 3);
  assert.equal(project.pipeline.getState().graph.nodes.length, 1);
  await project.read('cache.ts', 'completed');
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 3);
});

test('a configured active budget permits slower work and still rejects answers beyond that budget', async t => {
  for (const duration of [3500, 5500]) {
    const project = await workspace(t, { 'cache.ts': 'export function cacheComponent() {}\n' },
      input => {
        project.advance(duration);
        return judgment(input);
      }, { classificationDeadlineMs: 5000 });
    await project.read('cache.ts');
    await project.pipeline.whenIdle();
    assert.equal(project.calls[0].input.deadlineAt, project.calls[0].at + 5000);
    assert.equal(project.pipeline.getState().graph.nodes.length, duration < 5000 ? 1 : 0);
    assert.equal(project.pipeline.getState().status.classifier, duration < 5000 ? 'ready' : 'timeout');
    assert.equal(project.pipeline.getState().status.pending, 0);
  }
  const project = await workspace(t, {});
  for (const classificationDeadlineMs of [1999, 10_001, 2500.5, NaN]) {
    assert.throws(() => createPipeline({ projectRoot: project.root, classificationDeadlineMs }),
      /INVALID_CLASSIFICATION_DEADLINE/);
  }
});

test('a full Read can classify candidates omitted from an earlier small multi-file batch', async t => {
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  const files = Object.fromEntries(names.map(name => [`${name}.ts`,
    Array.from({ length: 8 }, (_, index) => `export function ${name}${index}() { return ${index}; }`).join('\n')]));
  const project = await workspace(t, files);
  await project.pipeline.ingest({
    hook_event_name: 'PostToolUse', session_id: 'orientation', tool_use_id: 'listing',
    tool_name: 'Glob', tool_input: { paths: Object.keys(files) }, tool_response: { success: true },
  });
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 1);
  assert.equal(project.pipeline.getState().graph.nodes.length, 12, 'the shared budget selected only three per file');
  await project.read('alpha.ts', 'full-read');
  await project.pipeline.whenIdle();
  const alphaCalls = project.calls.filter(call =>
    call.input.candidates.some(candidate => candidate.label === 'alpha7'));
  assert.equal(alphaCalls.length, 1, 'the later full file can fill in candidates omitted by grouping');
  assert.equal(project.pipeline.getState().graph.nodes.filter(node => node.label.startsWith('alpha')).length, 8);
});

test('explicit multi-file context remains eligible after both files were independently classified', async t => {
  const project = await workspace(t, {
    'alpha.ts': 'export function alphaModule() { return 1; }\n',
    'beta.ts': 'export function betaModule() { return 1; }\n',
  }, linkedJudgment);
  await project.start();
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 2);
  const together = id => project.pipeline.ingest({
    hook_event_name: 'PostToolUse', session_id: 'orientation', tool_use_id: id,
    tool_name: 'Read', tool_input: { paths: ['alpha.ts', 'beta.ts'] }, tool_response: { success: true },
  });
  await together('joint-context');
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 3);
  assert.equal(new Set(project.calls.at(-1).input.candidates.map(candidate => candidate.artifactId)).size, 2);
  assert.equal(project.pipeline.getState().graph.edges.length, 1);
  await together('same-joint-context');
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 3, 'the already examined context is also deduplicated');
  await project.pipeline.ingest({
    hook_event_name: 'PostToolUse', session_id: 'orientation', tool_use_id: 'reordered-context',
    tool_name: 'Read', tool_input: { paths: ['beta.ts', 'alpha.ts'] }, tool_response: { success: true },
  });
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 4, 'candidate order affects the finite relation proposal budget');
});

test('a joint observation is not deduplicated against the union of individual files still in flight', async t => {
  const project = await workspace(t, {
    'alpha.ts': 'export function alphaModule() { return 1; }\n',
    'beta.ts': 'export function betaModule() { return 1; }\n',
  }, (input, call, index) => index <= 2 ? gated(input, call) : linkedJudgment(input));
  await project.start();
  await project.pipeline.ingest({
    hook_event_name: 'PostToolUse', session_id: 'orientation', tool_use_id: 'joint-context',
    tool_name: 'Read', tool_input: { paths: ['alpha.ts', 'beta.ts'] }, tool_response: { success: true },
  });
  assert.equal(project.calls.length, 2);
  assert.equal(project.pipeline.getState().status.pending, 3, 'the relationship context gets its own queued job');
  project.calls.forEach(call => call.release());
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 3);
  assert.equal(project.pipeline.getState().graph.edges.length, 1);
});

test('queued source is superseded, fully reread, and rebuilt while missing files are skipped', async t => {
  const project = await workspace(t, {
    'a.ts': 'export function firstComponent() { return 1; }\n',
    'b.ts': 'export function secondComponent() { return 1; }\n',
    'cache.ts': 'export function oldCache() { return 1; }\n',
    'z.ts': 'export function deletedComponent() { return 1; }\n',
  }, (input, call, index) => index <= 2 ? gated(input, call) : judgment(input));
  await project.start();
  await writeFile(path.join(project.root, 'cache.ts'), 'export function intermediateCache() { return 2; }\n');
  await project.read('cache.ts', 'changed-while-queued');
  await writeFile(path.join(project.root, 'cache.ts'),
    `${'// moved declaration\n'.repeat(40)}export function currentCache() { return 3; }\n`);
  await rm(path.join(project.root, 'z.ts'));
  project.advance(500);
  project.calls.slice(0, 2).forEach(call => call.release());
  await project.pipeline.whenIdle();
  const labels = project.pipeline.getState().graph.nodes.map(node => node.label);
  assert.ok(labels.includes('currentCache'), 'whole-source rebuild finds the relocated declaration');
  assert.ok(!labels.includes('oldCache') && !labels.includes('intermediateCache') && !labels.includes('deletedComponent'));
  assert.equal(project.calls.length, 3, 'only the latest queued cache version reaches the classifier');
  assert.ok(project.records.some(record => record.reason === 'queued_source_superseded'));
  assert.ok(project.records.some(record => record.reason === 'queued_source_refreshed'));
  assert.ok(project.records.some(record => record.reason === 'queued_source_unavailable'));
  assert.equal(project.pipeline.getState().status.pending, 0);
});

test('the waiting queue is bounded and expired observations drain without remote calls or pending leaks', async t => {
  // Queue age uses the injected clock below. Freeze the separate active-job
  // watchdog while filling the queue: filesystem speed on a busy CI runner
  // must not release the two deliberately gated jobs before these assertions.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Explicit reads can discover source names outside the automatic extension list.
  const files = Object.fromEntries(Array.from({ length: 68 }, (_, index) =>
    [`source${index}.txt`, `export function component${index}() { return 1; }\n`]));
  const project = await workspace(t, files, gated);
  for (const name of Object.keys(files)) await project.read(name);
  assert.equal(project.calls.length, 2);
  assert.equal(project.pipeline.getState().status.pending, 66);
  assert.equal(project.records.filter(record => record.reason === 'classification_queue_full').length, 2);
  assert.equal(project.pipeline.getState().status.dropped, 2);
  project.advance(120_001);
  project.calls.forEach(call => call.release());
  await project.pipeline.whenIdle();
  assert.equal(project.calls.length, 2, 'expired waiting work never starts a remote workflow');
  assert.equal(project.records.filter(record => record.reason === 'classification_queue_expired').length, 64);
  assert.equal(project.pipeline.getState().status.pending, 0);
});

test('pause drains waiting work into deferred observations and resume preserves every file', async t => {
  const files = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map(name =>
    [`${name}.ts`, `export function ${name}Component() { return 1; }\n`]));
  const project = await workspace(t, files,
    (input, call, index) => index <= 2 ? gated(input, call) : judgment(input));
  await project.start();
  assert.equal(project.pipeline.getState().status.pending, 4);
  project.pipeline.setPaused(true);
  assert.equal(project.pipeline.getState().status.pending, 2);
  project.calls.forEach(call => call.release());
  await project.pipeline.whenIdle();
  assert.equal(project.pipeline.getState().graph.nodes.length, 0);
  assert.equal(project.pipeline.getState().status.pending, 0);
  project.pipeline.setPaused(false);
  await project.pipeline.whenIdle();
  assert.equal(project.pipeline.getState().graph.nodes.length, 4);
  assert.equal(project.pipeline.getState().status.pending, 0);
});

test('close cancels active and waiting classifications even when a classifier ignores cancellation', async t => {
  const project = await workspace(t, {
    'a.ts': 'export function alpha() {}\n',
    'b.ts': 'export function beta() {}\n',
    'c.ts': 'export function gamma() {}\n',
  }, gated);
  await project.start();
  assert.equal(project.pipeline.getState().status.pending, 3);
  await project.pipeline.close();
  assert.equal(project.calls.length, 2);
  assert.equal(project.pipeline.getState().status.pending, 0);
  assert.equal(project.pipeline.getState().status.connection, 'closed');
  project.calls.forEach(call => call.release());
  await project.pipeline.whenIdle();
  assert.equal(project.pipeline.getState().graph.nodes.length, 0);
});

test('a workflow retains its concurrency slot through final evidence acceptance', { concurrency: false }, async t => {
  const project = await workspace(t, {
    'a.ts': 'export function alpha() {}\n',
    'b.ts': 'export function beta() {}\n',
    'c.ts': 'export function gamma() {}\n',
  }, (input, call, index) => index <= 2 ? gated(input, call) : judgment(input));
  await project.start();
  const entered = gate(), release = gate();
  const original = EvidenceStore.prototype.reconcile;
  let intercepted = false;
  const mock = t.mock.method(EvidenceStore.prototype, 'reconcile', async function (...args) {
    if (!intercepted) {
      intercepted = true;
      entered.resolve();
      await release.promise;
    }
    return original.apply(this, args);
  });
  try {
    project.calls[0].release();
    await entered.promise;
    assert.equal(project.calls.length, 2, 'a remote answer alone does not release the workflow slot');
    assert.equal(project.pipeline.getState().status.pending, 3);
    release.resolve();
    await until(() => project.calls.length === 3);
    project.calls[1].release();
    await project.pipeline.whenIdle();
    assert.equal(project.pipeline.getState().graph.nodes.length, 3);
  } finally {
    release.resolve();
    project.calls.slice(0, 2).forEach(call => call.release());
    await project.pipeline.whenIdle();
    mock.mock.restore();
  }
});
