import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';

const source = 'export class Example { run() { return 42; } }\nexport function helper() { return 7; }\n';
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const answers = input => ({ status: 'accepted', answers: input.questions.map(question =>
  ({ id: question.id, kind: 'boolean', probability: 0.99, value: true })) });

async function fixture(t, { service, policy = { readSource: true }, onChange, files = {} } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'graphlin-live-activity-')), root = path.join(base, 'project');
  await mkdir(root);
  for (const [name, text] of Object.entries({ 'a.js': source, 'other.js': 'export const other = 1;', ...files })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  let time = 1_000_000, pipeline;
  const records = [];
  pipeline = createPipeline({ projectRoot: root, policy, decisionService: service,
    clock: () => time, onChange: () => { if (pipeline) onChange?.(pipeline); }, onDiagnostic: record => records.push(record) });
  t.after(async () => { await pipeline.close(); await rm(base, { recursive: true, force: true }); });
  const send = (kind, { name = 'Read', file = 'a.js', call = 'one', session = 'session-a', agent,
    input, response, host = 'claude', cwd = root } = {}) => {
    time += 10;
    return pipeline.ingest({ cwd, hook_event_name: kind, session_id: session,
      ...(agent ? { agent_id: agent } : {}), ...(call ? { tool_use_id: call } : {}),
      tool_name: name, tool_input: input ?? (file ? { file_path: path.join(root, file) } : {}),
      tool_response: response ?? { success: true },
    }, { host });
  };
  const toolActivity = () => pipeline.getModelState().activity.filter(value =>
    value.kind.startsWith('tool.') || value.kind === 'activity.mapped');
  return { root, base, pipeline, records, send, toolActivity };
}

test('a named-file request is visible before parsing and never attributes incidental discovery', async t => {
  let immediate;
  const f = await fixture(t, { onChange(pipeline) {
    const model = pipeline.getModelState(), row = model.activity.find(value => value.kind === 'tool.requested');
    if (row && !immediate) immediate = { row, targets: model.entities.filter(entity => row.entityIds.includes(entity.id)) };
  } });
  await f.send('PreToolUse');
  assert.equal(immediate.row.operation, 'read');
  assert.equal(immediate.row.mapping, 'exact');
  assert.equal(immediate.row.outcome, 'pending');
  assert.deepEqual(immediate.row.sourceRefs, []);
  assert.deepEqual(immediate.targets.map(entity => entity.kind), ['file']);
  assert.equal(immediate.targets[0].basis, 'metadata');
  await f.pipeline.whenIdle();
  let model = f.pipeline.getModelState();
  const module = model.entities.find(entity => entity.kind === 'module' && entity.label === 'a.js');
  assert.ok(f.toolActivity()[0].entityIds.includes(module.id), 'exact activity follows the metadata file into its parsed module');
  await f.send('PostToolUse', { response: { success: true, paths: ['other.js'] } });
  await f.pipeline.whenIdle();
  model = f.pipeline.getModelState();
  const latest = f.toolActivity().at(-1);
  assert.equal(latest.outcome, 'succeeded');
  assert.deepEqual(latest.artifactIds, [module.artifactId]);
  assert.deepEqual(latest.entityIds, [module.id]);
  assert.ok(model.entities.some(entity => entity.label === 'other.js'), 'incidental discovery still populates the global model');
  assert.ok(f.toolActivity().every(row => row.creation === false));
});

test('tool working directories scope exact activity and source capture to the same named file', async t => {
  for (const directory of ['workdir', 'cwd', 'relative', 'hook']) await t.test(directory, async t => {
    const f = await fixture(t, { files: { 'src/a.js': 'export class NestedExample {}' } });
    const input = { cmd: 'cat a.js' };
    if (directory === 'relative') input.workdir = 'src';
    else if (directory !== 'hook') input[directory] = path.join(f.root, 'src');
    await f.send('PreToolUse', { name: 'exec_command', host: 'codex', input,
      cwd: directory === 'hook' ? path.join(f.root, 'src') : f.root });
    await f.pipeline.whenIdle();
    const model = f.pipeline.getModelState(), activity = f.toolActivity().at(-1);
    const artifacts = model.coverage.artifacts;
    assert.deepEqual(artifacts.map(value => value.relativePath), ['src/a.js']);
    assert.deepEqual(activity.artifactIds, [artifacts[0].id]);
    assert.ok(model.entities.some(entity => entity.label === 'NestedExample'));
    assert.equal(model.entities.some(entity => entity.label === 'Example'), false,
      'the identically named root file is not captured');
    assert.ok(activity.entityIds.every(id => model.entities.find(entity => entity.id === id)?.artifactId === artifacts[0].id));
    assert.doesNotMatch(JSON.stringify([model.activity, f.records]), /cat a\.js|workingDirectory|tool_input/);
  });
});

test('outside, missing and symlink tool working directories cannot fall back to the root filename', async t => {
  for (const directory of ['outside', 'missing', 'symlink']) await t.test(directory, async t => {
    const f = await fixture(t, { files: { 'src/a.js': source } });
    await writeFile(path.join(f.base, 'a.js'), 'export const outside = 1;');
    await symlink(path.join(f.root, 'src'), path.join(f.root, 'alias'));
    const workdir = directory === 'outside' ? f.base : path.join(f.root, directory === 'symlink' ? 'alias' : 'missing');
    await f.send('PreToolUse', { name: 'exec_command', host: 'codex', input: { cmd: 'cat a.js', workdir } });
    await f.pipeline.whenIdle();
    assert.deepEqual(f.toolActivity().at(-1).entityIds, []);
    assert.deepEqual(f.toolActivity().at(-1).artifactIds, []);
    assert.deepEqual(f.pipeline.getModelState().coverage.artifacts, []);
  });
});

test('terminal failure and denial inherit exact targets when the host omits input paths', async t => {
  for (const [kind, outcome] of [
    ['PostToolUseFailure', 'failed'], ['PermissionDenied', 'denied'], ['Interrupt', 'interrupted'],
  ]) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.send('PreToolUse', { name: 'Edit' });
    const pending = f.toolActivity().at(-1);
    await f.send(kind, { name: 'Edit', file: null });
    const finished = f.toolActivity().at(-1);
    assert.equal(finished.outcome, outcome);
    assert.equal(finished.operation, 'edit');
    assert.deepEqual(finished.artifactIds, pending.artifactIds);
    assert.ok(finished.entityIds.length);
    await f.send('PreToolUse', { name: 'Edit' });
    assert.equal(f.toolActivity().at(-1).outcome, outcome, 'late requests cannot resurrect a finished call');
  });
});

test('stop completes only the correlated agent/session pending calls with unknown outcome', async t => {
  const f = await fixture(t);
  await f.send('PreToolUse', { session: 'session-a', agent: 'worker' });
  await f.send('PreToolUse', { session: 'session-b', agent: 'worker' });
  await f.send('PreToolUse', { session: 'session-a', agent: 'other', call: 'two' });
  const pending = f.toolActivity().filter(row => row.outcome === 'pending');
  await f.send('Stop', { session: 'session-a', agent: 'worker', call: null, file: null });
  const finished = f.toolActivity().filter(row => row.kind === 'tool.unresolved');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].sessionId, pending[0].sessionId);
  assert.equal(finished[0].agentId, pending[0].agentId);
  assert.deepEqual(finished[0].artifactIds, pending[0].artifactIds);
  assert.equal(finished[0].outcome, 'unresolved');
  assert.equal(finished[0].creation, false);
});

test('missing new writes, excluded paths and symlink aliases do not fabricate canonical file targets', async t => {
  const f = await fixture(t, { policy: {} });
  await writeFile(path.join(f.root, '.env'), 'SYNTHETIC_PRIVATE_BODY');
  await symlink(path.join(f.root, '.env'), path.join(f.root, 'alias.js'));
  for (const [call, file] of [['new', 'new.js'], ['private', '.env'], ['alias', 'alias.js']]) {
    await f.send('PreToolUse', { name: 'Write', call, file });
    assert.deepEqual(f.toolActivity().at(-1).entityIds, []);
  }
  await writeFile(path.join(f.root, 'new.js'), 'export const created = 1;');
  await f.send('PostToolUse', { name: 'Write', call: 'new', file: 'new.js' });
  assert.ok(f.toolActivity().at(-1).entityIds.length);
  assert.doesNotMatch(JSON.stringify([f.pipeline.getModelState(), f.records]), /SYNTHETIC_PRIVATE_BODY|\.env/);
});

test('a late semantic mapping preserves a completed call outcome and lifecycle timestamp', async t => {
  const entered = gate(), release = gate(), requests = [];
  t.after(() => release.resolve());
  const f = await fixture(t, { policy: { transmitSource: true }, service: {
    async evaluate(input) { requests.push(input); entered.resolve(); await release.promise; return answers(input); },
  } });
  await f.send('PreToolUse');
  await entered.promise;
  await f.send('PostToolUse', { file: null });
  const finished = f.toolActivity().at(-1);
  assert.equal(finished.outcome, 'succeeded', 'hook intake is independent of the held provider');
  release.resolve();
  await f.pipeline.whenIdle();
  const mapped = f.toolActivity().at(-1);
  assert.equal(mapped.kind, 'activity.mapped');
  assert.equal(mapped.mapping, 'decision');
  assert.equal(mapped.outcome, 'succeeded');
  assert.equal(mapped.at, finished.at);
  assert.equal(mapped.toolCallId, finished.toolCallId);
  assert.ok(mapped.entityIds.length > 1);
  assert.equal(mapped.sourceRefs.length, 1);
  assert.equal(f.pipeline.getState().activity[0].state, 'succeeded');
  assert.doesNotMatch(JSON.stringify(requests), /return 42|file_path|tool_input|a\.js/);
});

test('a terminal repeating its filename retains decision targets only for the same current file version', async t => {
  for (const changed of [false, true]) await t.test(changed ? 'changed source' : 'same source', async t => {
    const f = await fixture(t, { policy: { transmitSource: true },
      service: { async evaluate(input) { return answers(input); } } });
    await f.send('PreToolUse');
    await f.pipeline.whenIdle();
    const mapped = f.toolActivity().at(-1);
    assert.equal(mapped.mapping, 'decision');
    if (changed) await writeFile(path.join(f.root, 'a.js'), 'export const replacement = 1;');
    await f.send('PostToolUse');
    const terminal = f.toolActivity().findLast(row => row.kind === 'tool.succeeded');
    assert.equal(terminal.outcome, 'succeeded');
    assert.equal(terminal.mapping, changed ? 'exact' : 'decision');
    if (changed) {
      assert.deepEqual(terminal.sourceRefs, []);
      const model = f.pipeline.getModelState();
      assert.ok(terminal.entityIds.every(id => ['file', 'module'].includes(model.entities.find(entity => entity.id === id)?.kind)));
    } else {
      assert.deepEqual(terminal.entityIds, mapped.entityIds);
      assert.deepEqual(terminal.sourceRefs, mapped.sourceRefs);
    }
  });
});

test('an answer for old evidence is rejected even when the disk edit had no hook', async t => {
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t, { policy: { transmitSource: true }, service: {
    async evaluate(input) { entered.resolve(); await release.promise; return answers(input); },
  } });
  await f.send('PreToolUse');
  await entered.promise;
  await writeFile(path.join(f.root, 'a.js'), source.replace('Example', 'Changed'));
  release.resolve();
  await f.pipeline.whenIdle();
  assert.equal(f.toolActivity().some(row => row.kind === 'activity.mapped'), false);
  assert.equal(f.toolActivity().at(-1).mapping, 'exact');
});

test('local consent and abstention keep exact targets without claiming semantic mapping', async t => {
  for (const remote of [false, true]) await t.test(remote ? 'abstention' : 'local consent', async t => {
    let calls = 0;
    const f = await fixture(t, { policy: remote ? { transmitSource: true } : { readSource: true },
      service: { async evaluate() { calls++; return { status: 'abstained' }; } } });
    await f.send('PreToolUse');
    await f.pipeline.whenIdle();
    assert.equal(calls, remote ? 1 : 0);
    assert.equal(f.toolActivity().at(-1).mapping, 'exact');
    assert.ok(f.toolActivity().at(-1).entityIds.length);
    assert.ok(f.records.some(record => record.stage === 'classification' &&
      record.reason === (remote ? 'no_accepted_classification' : 'metadata_only')));
  });
});

test('explicit read line hints reach the provider only as bounded artifact aliases', async t => {
  const requests = [];
  const f = await fixture(t, { policy: { transmitSource: true },
    service: { async evaluate(input) { requests.push(input); return answers(input); } } });
  await f.send('PreToolUse', { input: { file_path: path.join(f.root, 'a.js'), offset: 2, limit: 1 } });
  await f.pipeline.whenIdle();
  assert.deepEqual(requests[0].state.lineHints, [{ file: 'file_0', startLine: 2, endLine: 2 }]);
  const trace = f.records.find(record => record.stage === 'classification' && record.reason === 'approved');
  assert.ok(trace.diagnostics.trace.requests[0].candidateCount > 0);
  assert.ok(trace.diagnostics.trace.requests[0].approvedCount > 0);
  assert.doesNotMatch(JSON.stringify([requests, f.records, f.pipeline.getModelState().activity]), /file_path|activityRanges|return 42/);
});

test('a stalled mapper times out with visible diagnostics while retaining exact pending activity', async t => {
  const f = await fixture(t, { policy: { transmitSource: true },
    service: { evaluate: () => new Promise(() => {}) } });
  await f.send('PreToolUse');
  assert.equal(f.toolActivity().at(-1).outcome, 'pending');
  await f.pipeline.whenIdle();
  assert.equal(f.toolActivity().at(-1).mapping, 'exact');
  assert.ok(f.records.some(record => record.reason === 'deadline_exceeded' &&
    record.diagnostics?.trace?.requests[0].candidateCount > 0));
});

test('pause, session end and lineage changes reject in-flight activity mappings', async t => {
  for (const change of ['pause', 'session end', 'lineage']) await t.test(change, async t => {
    const entered = gate(), release = gate();
    t.after(() => release.resolve());
    const f = await fixture(t, { policy: { transmitSource: true }, service: {
      async evaluate(input) { entered.resolve(); await release.promise; return answers(input); },
    } });
    await f.pipeline.observeLineage({ id: 'a'.repeat(64), status: 'git' });
    await f.send('PreToolUse');
    await entered.promise;
    if (change === 'pause') f.pipeline.setPaused(true);
    else if (change === 'session end') await f.send('SessionEnd', { call: null, file: null });
    else await f.pipeline.observeLineage({ id: 'b'.repeat(64), status: 'git' });
    release.resolve();
    await f.pipeline.whenIdle();
    assert.equal(f.toolActivity().some(row => row.kind === 'activity.mapped'), false);
    assert.ok(f.records.some(record => record.reason === 'cancelled' || record.reason === 'stale_evidence'));
  });
});

test('full relationship guard references are checked while activity keeps bounded artifact versions', async t => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) =>
    [`part-${i}.js`, 'export const value = 1;']));
  files['a.js'] = Array.from({ length: 28 }, (_, i) =>
    `import { value as local${i} } from './part-${i % 7}.js';`).join('\n') + '\nexport const app = 1;';
  const requests = [];
  const f = await fixture(t, { files, policy: { transmitSource: true },
    service: { async evaluate(input) { requests.push(input); return answers(input); } } });
  await f.send('PreToolUse', { name: 'MultiEdit', input: { files: Object.keys(files) } });
  await f.pipeline.whenIdle();
  assert.ok(requests.length, JSON.stringify(f.records.filter(record => record.stage === 'classification')));
  assert.ok(requests[0].state.relations.length >= 16, 'exercise more than sixteen relationship support spans');
  const mapped = f.toolActivity().find(row => row.kind === 'activity.mapped');
  assert.ok(mapped);
  assert.equal(mapped.sourceRefs.length, 8);
  assert.equal(new Set(mapped.sourceRefs.map(ref => ref.artifactId)).size, 8);
});

test('mapping admission is bounded and overflow retains exact file activity', async t => {
  const release = gate();
  t.after(() => release.resolve());
  let active = 0, peak = 0, calls = 0;
  const f = await fixture(t, { policy: { transmitSource: true }, service: {
    async evaluate(input) {
      calls++; active++; peak = Math.max(peak, active);
      await release.promise;
      active--;
      return answers(input);
    },
  } });
  for (let i = 0; i < 50; i++) await f.send('PreToolUse', { call: `read-${i}` });
  release.resolve();
  await f.pipeline.whenIdle();
  assert.ok(peak <= 2);
  assert.ok(calls <= 34, 'two active and thirty-two queued metadata decisions');
  assert.ok(f.records.some(record => record.reason === 'queue_full'));
  const requests = f.toolActivity().filter(row => row.kind === 'tool.requested');
  assert.equal(requests.length, 50);
  assert.ok(requests.every(row => row.mapping === 'exact' && row.entityIds.length));
});
