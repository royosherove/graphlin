import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createDiagnostics, readPersistedDiagnostics, diagnosticArtifactId, DIAGNOSTIC_LIMITS } from '../../runtime/daemon/diagnostics.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { EvidenceStore } from '../../runtime/core/evidence.mjs';
import { opaque } from '../../runtime/core/common.mjs';
import { createDecisionService } from '../../runtime/jev/index.mjs';
import { ACTIVITIES, ROLES } from '../../runtime/jev/questions.mjs';
import { candidate, proposal, input, makeCore, recordingTransport } from '../jev/helpers.mjs';
import { workspace } from './helpers.mjs';

const id = (kind, value = 'fixture') => opaque(kind, value);
function record(root, extra = {}) {
  const artifactId = diagnosticArtifactId(root, 'src/cache.ts');
  return {
    schemaVersion: 1, at: '2026-09-19T12:00:00.000Z', stage: 'classification',
    eventId: id('event'), sourceEventId: id('event', 'source'), sessionId: id('session'),
    eventKind: 'artifact.changed', toolCategory: 'edit', status: 'accepted', reason: 'ok',
    artifacts: [{ artifactId, path: 'src/cache.ts', status: 'present', complete: true,
      candidateCount: 1, availableCandidates: 2, reason: 'candidate_limit' }],
    candidates: [{ candidateId: id('candidate'), artifactId, label: 'CacheStore',
      sourceClass: 'source', startLine: 1, endLine: 4, complete: true }],
    diagnostics: {
      code: 'ok', codes: [], mode: 'demo', durationMs: 5, calls: 2, usageIncomplete: false,
      candidatesOmitted: 0, proposalsOmitted: 0, questionCounts: { A: 3, B: 3 },
      stageDurationMs: { A: 2, B: 3 }, usage: { input_tokens: 10, output_tokens: 2 },
      intakePolicyVersion: 'intake-policy-v1', admissionPolicyVersion: 'admission-policy-v1',
      extraction: [{ artifactId, available: 2, selected: 1, reason: 'candidate_limit' }],
      admission: [{ candidateId: id('candidate'), status: 'accepted', reason: 'ok' }],
    },
    patch: { revisionBefore: 0, revisionAfter: 1, nodesAdded: 1, nodesUpdated: 0, nodesRemoved: 0,
      edgesAdded: 0, edgesUpdated: 0, edgesRemoved: 0 },
    ...extra,
  };
}
async function setupLogger(t, policy = {}) {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  const logger = await createDiagnostics({ ...paths, policy: { transmitSource: true, ...policy } });
  t.after(() => logger.close());
  return { ...setup, paths, logger };
}

test('discovery queue timing is retained without accepting arbitrary queue data', async t => {
  const { projectRoot, logger, paths } = await setupLogger(t);
  const queue = { waitMs: 3200, depth: 6, active: 2, capacity: 64, omitted: 0 };
  logger.record(record(projectRoot, { diagnostics: { queue: {
    ...queue, source: 'RAW_SOURCE', command: 'RAW_COMMAND', token: 'RAW_TOKEN',
  } } }));
  logger.record(record(projectRoot, { diagnostics: { queue: {
    waitMs: 'RAW_SECRET', depth: -1, active: Infinity, capacity: NaN, omitted: {},
  } } }));
  assert.deepEqual(logger.snapshot().records[0].diagnostics.queue, queue);
  assert.deepEqual(logger.snapshot().records[1].diagnostics.queue, {});
  await logger.close();
  const disk = await readPersistedDiagnostics(paths);
  assert.deepEqual(disk.records[0].diagnostics.queue, queue);
  assert.doesNotMatch(JSON.stringify(disk), /RAW_/);
});

test('architecture diagnostics retain only bounded counts, fixed stages and safe reason codes', async t => {
  const { projectRoot, logger, paths } = await setupLogger(t);
  const coverage = { stage: 'analysis', attempted: 5, analyzed: 0, withheld: 1, unsupported: 4, unavailable: 0, deferred: 0 };
  logger.record(record(projectRoot, { reason: 'source_withheld', diagnostics: {
    code: 'source_withheld', calls: 0, architecture: { ...coverage, error: 'RAW_ERROR', paths: ['RAW_PATH'] },
  } }));
  logger.record(record(projectRoot, { reason: 'analysis_failed', diagnostics: {
    code: 'architecture_capture_failed',
    architecture: { stage: 'RAW_STAGE', attempted: 10_001, analyzed: -1, withheld: 'RAW_COUNT', unavailable: Infinity },
  } }));
  const values = logger.snapshot().records;
  assert.deepEqual(values[0].diagnostics.architecture, coverage);
  assert.equal(values[0].reason, 'source_withheld');
  assert.equal(values[1].diagnostics.code, 'architecture_capture_failed');
  assert.deepEqual(values[1].diagnostics.architecture, {});
  await logger.close();
  const disk = await readPersistedDiagnostics(paths);
  assert.deepEqual(disk.records[0].diagnostics.architecture, coverage);
  assert.doesNotMatch(JSON.stringify(disk), /RAW_/);
});

test('discovery queue and coverage reasons remain searchable in the diagnostic log', async t => {
  const { projectRoot, logger, paths } = await setupLogger(t);
  const reasons = [
    'classification_queued', 'classification_queue_full', 'classification_queue_expired',
    'queued_source_superseded', 'queued_source_refreshed', 'queued_source_unavailable',
    'source_version_completed', 'source_version_pending',
  ];
  for (const reason of reasons) logger.record(record(projectRoot, {
    reason, status: reason === 'classification_queued' ? 'queued' : 'skipped',
  }));
  assert.deepEqual(logger.snapshot().records.map(record => record.reason), reasons);
  await logger.close();
  assert.deepEqual((await readPersistedDiagnostics(paths)).records.map(record => record.reason), reasons);
});

test('diagnostics detach safe metadata and enforce independent display and persistence policies', async t => {
  for (const displayEvidence of [true, false]) for (const persistEvidence of [true, false]) {
    const { projectRoot, paths, logger } = await setupLogger(t, { displayEvidence, persistEvidence });
    const original = record(projectRoot);
    assert.equal(logger.record(original), true);
    original.artifacts[0].path = 'mutated.ts';
    original.diagnostics.extraction[0].reason = 'RAW_ERROR';
    const live = logger.snapshot().records[0];
    assert.equal(live.artifacts[0].path, displayEvidence ? 'src/cache.ts' : undefined);
    assert.equal(live.candidates[0].label, displayEvidence ? 'CacheStore' : undefined);
    assert.equal(live.artifacts[0].availableCandidates, 2);
    assert.equal(live.diagnostics.extraction[0].reason, 'candidate_limit');
    assert.equal(live.diagnostics.admission[0].status, 'accepted');
    live.diagnostics.extraction[0].reason = 'mutated';
    assert.equal(logger.snapshot().records[0].diagnostics.extraction[0].reason, 'candidate_limit');
    await logger.flush();
    const persisted = await readPersistedDiagnostics({ ...paths, policy: { transmitSource: true } });
    assert.equal(persisted.records[0].artifacts[0].path, persistEvidence ? 'src/cache.ts' : undefined);
    assert.equal(persisted.records[0].candidates[0].label, persistEvidence ? 'CacheStore' : undefined);
    assert.equal(persisted.records[0].id, live.id);
    assert.equal(persisted.records[0].seq, 1);
    assert.equal((await fs.stat(logger.stats().logPath)).mode & 0o777, 0o600);
  }
});

test('extraction retains pre-cap availability, snippet-limit reasons and only boolean truncation flags', async t => {
  const { projectRoot, paths, logger } = await setupLogger(t);
  const artifactId = diagnosticArtifactId(projectRoot, 'src/cache.ts');
  const extraction = [true, false, 'RAW_FLAG'].map(truncated => ({
    artifactId, available: 1025, selected: 12, reason: 'snippet_limit', truncated,
  }));
  assert.equal(logger.record(record(projectRoot, { diagnostics: { extraction } })), true);
  const expected = extraction.map(({ truncated, ...entry }) => ({
    ...entry, ...(typeof truncated === 'boolean' ? { truncated } : {}),
  }));
  assert.deepEqual(logger.snapshot().records[0].diagnostics.extraction, expected);
  await logger.close();
  const persisted = await readPersistedDiagnostics(paths);
  assert.deepEqual(persisted.records[0].diagnostics.extraction, expected);
  assert.doesNotMatch(JSON.stringify(persisted), /RAW_FLAG/);
});

test('tightening source permission hides previously persisted evidence and future entries, including default stopped reads', async t => {
  const { projectRoot, paths, logger } = await setupLogger(t, { displayEvidence: true, persistEvidence: true });
  logger.record(record(projectRoot)); await logger.close();
  assert.match(await fs.readFile(logger.stats().logPath, 'utf8'), /src\/cache\.ts|CacheStore/);
  const tightened = await createDiagnostics({ ...paths,
    policy: { transmitSource: false, displayEvidence: true, persistEvidence: true } });
  t.after(() => tightened.close());
  tightened.record(record(projectRoot));
  const live = tightened.snapshot();
  assert.equal(live.records.length, 2);
  assert.doesNotMatch(JSON.stringify(live), /src\/cache\.ts|CacheStore/);
  await tightened.close();
  const lines = (await fs.readFile(logger.stats().logPath, 'utf8')).trim().split('\n');
  assert.doesNotMatch(lines.at(-1), /src\/cache\.ts|CacheStore/);
  assert.doesNotMatch(JSON.stringify(await readPersistedDiagnostics(paths)), /src\/cache\.ts|CacheStore/);
  assert.equal((await readPersistedDiagnostics(paths)).records[0].artifacts[0].artifactId,
    diagnosticArtifactId(paths.projectRoot, 'src/cache.ts'));
});

test('raw strings, source, prompts, errors and unsafe paths never enter logs even with evidence enabled', async t => {
  const { projectRoot, logger } = await setupLogger(t, { displayEvidence: true, persistEvidence: true });
  const value = record(projectRoot);
  Object.assign(value, { prompt: 'RAW_PROMPT', text: 'RAW_SOURCE', transcript: 'RAW_TRANSCRIPT',
    error: 'RAW_ERROR', token: 'RAW_TOKEN', key: 'RAW_KEY', status: 'RAW_STATUS', reason: 'RAW_REASON' });
  const unsafe = ['/Users/example/secret.ts', '../cache.ts', 'src/../cache.ts', 'src/.env.local',
    'src\\cache.ts', 'src/API_KEY=RAW_PATH', 'src/\nRAW_PATH', 'src/secret.ts'];
  value.artifacts = unsafe.map((file, i) => ({ ...value.artifacts[0], path: file,
    artifactId: id('artifact', String(i)), text: 'RAW_SOURCE', reason: 'RAW_REASON' }));
  value.candidates[0] = { ...value.candidates[0], label: 'token="RAW_CREDENTIAL"',
    text: 'RAW_SOURCE', startLine: 'RAW_NUMBER' };
  value.diagnostics.trace = {
    version: 1, outcome: { status: 'RAW_STATUS', code: 'RAW_CODE', message: 'RAW_ERROR' },
    activity: { choice: 'RAW_ACTIVITY', confidence: 'RAW_CONFIDENCE',
      probabilities: { inspect: Infinity, implement: 'RAW_PROBABILITY', RAW_OPTION: 1 } },
    relevance: NaN, prompt: 'RAW_PROMPT',
    thresholds: { intake: { sensitiveMax: 'RAW_NUMBER', relevantMin: Infinity, apiKey: 'RAW_KEY' } },
    intake: [{ candidateId: 'RAW_ID', relevant: 'RAW_NUMBER', sensitive: Infinity,
      approved: true, reason: 'RAW_REASON', label: 'RAW_LABEL' }],
    nodes: [{ role: 'RAW_ROLE', reasons: ['RAW_REASON'], supportProbability: -1,
      roleProbabilities: { service: 'RAW_PROBABILITY', function: Infinity, RAW_OPTION: 1 } }],
    requests: [{ stage: 'A', model: 'RAW_MODEL', rubricVersion: 'RAW_RUBRIC', httpStatus: 'RAW_STATUS',
      usage: { input_tokens: 'RAW_NUMBER', output_tokens: Infinity, response: 'RAW_RESPONSE' }, body: 'RAW_BODY' }],
  };
  assert.equal(logger.record(value), true);
  await logger.close();
  for (const serialized of [JSON.stringify(logger.snapshot()), await fs.readFile(logger.stats().logPath, 'utf8')]) {
    assert.doesNotMatch(serialized, /RAW_|\/Users\/alice|src\/\.env|src\/secret/);
    assert.doesNotMatch(serialized, /"prompt"|"text"|"transcript"|"error"|"token"|"key"|"body"/);
  }
  const clean = logger.snapshot().records[0];
  assert.equal(clean.reason, 'unknown');
  assert.ok(clean.artifacts.every(artifact => artifact.path === undefined));
  assert.equal(clean.candidates[0].label, undefined);
  assert.equal(clean.diagnostics.trace.requests[0].usage.input_tokens, undefined);
  assert.deepEqual(clean.diagnostics.trace.activity, { probabilities: {} });
  assert.deepEqual(clean.diagnostics.trace.nodes[0].roleProbabilities, {});
});

test('activity Choice and full role distributions survive logging with null preserving unavailable activity', async t => {
  const { projectRoot, logger, paths } = await setupLogger(t);
  logger.record(record(projectRoot, { diagnostics: { trace: { version: 1, activity: null } } }));
  const activity = { choice: 'repair', confidence: 0.83,
    probabilities: Object.fromEntries(ACTIVITIES.map(value => [value, value === 'repair' ? 0.94 : 0.01])) };
  const roleProbabilities = Object.fromEntries(ROLES.map(value => [value, value === 'function' ? 0.88 : 0.01]));
  const trace = { version: 1, activity, nodes: [{ candidateId: id('candidate'), role: 'function', roleProbabilities }] };
  logger.record(record(projectRoot, { diagnostics: { trace } }));
  const live = logger.snapshot();
  assert.equal(live.records[0].diagnostics.trace.activity, null);
  assert.deepEqual(live.records[1].diagnostics.trace, trace);
  await logger.close();
  const persisted = await readPersistedDiagnostics(paths);
  assert.equal(persisted.records[0].diagnostics.trace.activity, null);
  assert.deepEqual(persisted.records[1].diagnostics.trace, trace);
});

test('the full maximum-candidate Jev trace survives unchanged, including irrelevant judgments and request metadata', async t => {
  const { projectRoot, logger } = await setupLogger(t);
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(id('candidate', String(i))));
  const proposals = Array.from({ length: 7 }, (_, i) => proposal(id('proposal', String(i)), {
    sourceCandidateId: candidates[0].id, targetCandidateId: candidates[i + 1].id,
    evidenceCandidateIds: [candidates[0].id, candidates[i + 1].id],
  }));
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_relevance) value.answers.b_relevance.noul = 0.2;
    return value;
  });
  const service = createDecisionService({ apiKey: 'OFFLINE_FIXTURE', ...makeCore({ proposals }), ...transport });
  t.after(() => service.close());
  const result = await service.classify(input({ candidates }));
  const value = record(projectRoot, {
    diagnostics: result.diagnostics,
    candidates: candidates.map(c => ({ candidateId: c.id, artifactId: id('artifact'), label: 'A'.repeat(80),
      startLine: 1, endLine: 24, sourceClass: 'source', complete: true })),
  });
  assert.equal(logger.record(value), true);
  assert.deepEqual(logger.snapshot().records[0].diagnostics.trace, result.diagnostics.trace);
  assert.equal(logger.snapshot().records[0].diagnostics.trace.nodes.length, 12);
  assert.equal(logger.snapshot().records[0].diagnostics.trace.edges.length, 7);
  assert.equal(logger.snapshot().records[0].diagnostics.trace.nodes[0].classification, 'skipped');
  assert.equal(logger.stats().truncated, 0);
  await logger.flush();
  const disk = JSON.parse((await fs.readFile(logger.stats().logPath, 'utf8')).trim());
  assert.deepEqual(disk.diagnostics.trace, result.diagnostics.trace);
  // A caller can combine extraction, admission and long artifact metadata in
  // one record. Keep its cause and mark coherent evidence-name truncation.
  const oversized = structuredClone(value);
  oversized.artifacts = Array.from({ length: 32 }, (_, i) => ({
    artifactId: id('artifact', String(i)), path: `${'x'.repeat(490)}/${i}.ts`,
    status: 'present', complete: true, candidateCount: 12, availableCandidates: 12, reason: 'candidates_ready',
  }));
  oversized.diagnostics.extraction = oversized.artifacts.map(item => ({
    artifactId: item.artifactId, available: 12, selected: 12, reason: 'candidates_ready',
  }));
  oversized.diagnostics.admission = Array.from({ length: 32 }, (_, i) => ({
    candidateId: id('candidate', String(i)), proposalId: id('proposal', String(i)),
    status: 'skipped', reason: 'endpoints_not_drawable',
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > DIAGNOSTIC_LIMITS.recordBytes);
  assert.equal(logger.record(oversized), true);
  const shortened = logger.snapshot().records.at(-1);
  assert.equal(shortened.truncated, true);
  assert.equal(shortened.reason, 'ok');
  assert.deepEqual(shortened.diagnostics.trace, result.diagnostics.trace);
  assert.equal(logger.stats().dropped, 0);
  assert.equal(logger.stats().truncated, 1);
});

test('failed Jev requests retain null unknown fields and numeric status without error bodies', async t => {
  const { projectRoot, logger } = await setupLogger(t);
  const service = createDecisionService({ apiKey: 'OFFLINE_FIXTURE', ...makeCore(),
    fetchImpl: async () => { throw new Error('RAW_TRANSPORT_SECRET'); } });
  t.after(() => service.close());
  const result = await service.classify(input());
  logger.record(record(projectRoot, { diagnostics: result.diagnostics }));
  assert.deepEqual(logger.snapshot().records[0].diagnostics.trace, result.diagnostics.trace);
  assert.equal(logger.snapshot().records[0].diagnostics.trace.requests[0].httpStatus, null);
  assert.doesNotMatch(JSON.stringify(logger.snapshot()), /RAW_TRANSPORT_SECRET|OFFLINE_FIXTURE/);
});

test('artifact filters match EvidenceStore IDs through canonical aliases and after deletion', async t => {
  const { base, projectRoot, paths, logger } = await setupLogger(t);
  await fs.mkdir(path.join(projectRoot, 'src'));
  await fs.writeFile(path.join(projectRoot, 'src/cache.ts'), 'export function cache() {}');
  const alias = path.join(base, 'project alias');
  await fs.symlink(projectRoot, alias);
  const store = new EvidenceStore({ projectRoot: paths.projectRoot });
  const [artifact] = await store.capture(['src/cache.ts']);
  assert.equal(diagnosticArtifactId(paths.projectRoot, 'src/cache.ts'), artifact.id);
  assert.equal(diagnosticArtifactId(paths.projectRoot, path.join(alias, 'src/cache.ts'), alias), artifact.id);
  logger.record(record(projectRoot));
  logger.record(record(projectRoot, { artifacts: [], candidates: [] }));
  await fs.rm(path.join(projectRoot, 'src/cache.ts'));
  assert.equal(logger.snapshot({ artifactId: artifact.id }).records.length, 1);
  assert.equal(logger.snapshot({ artifactId: id('artifact', 'other') }).records.length, 0);
  assert.throws(() => diagnosticArtifactId(projectRoot, '../cache.ts'), { code: 'invalid_log_filter' });
  assert.throws(() => logger.snapshot({ artifactId: 'src/cache.ts' }), { code: 'invalid_log_filter' });
});

test('rings bound both records and bytes, preserve sequence order and resume sequence after restart', async t => {
  const { projectRoot, paths, logger } = await setupLogger(t);
  for (let i = 0; i < 360; i++) {
    logger.record(record(projectRoot, { eventId: id('event', String(i)) }));
    if (i % 50 === 49) await logger.flush();
  }
  const snapshot = logger.snapshot();
  assert.ok(snapshot.records.length <= 300);
  assert.ok(snapshot.stats.ringBytes <= DIAGNOSTIC_LIMITS.ringBytes);
  assert.ok(snapshot.stats.evicted > 0);
  assert.equal(snapshot.records.at(-1).seq, 360);
  assert.ok(snapshot.records.every((entry, i, rows) => !i || rows[i - 1].seq < entry.seq));
  await logger.close();
  const reopened = await createDiagnostics(paths);
  t.after(() => reopened.close());
  reopened.record(record(projectRoot));
  assert.equal(reopened.snapshot().records.at(-1).seq, 361);
  assert.notEqual(reopened.snapshot().records.at(-1).id, snapshot.records.at(-1).id);
  assert.equal(logger.record(record(projectRoot)), false);
});

test('private JSONL rotation keeps exactly one bounded backup with chronologically readable records', async t => {
  const { projectRoot, paths, logger } = await setupLogger(t, { persistEvidence: true });
  const value = record(projectRoot);
  value.artifacts = Array.from({ length: 32 }, (_, i) => ({
    ...value.artifacts[0], artifactId: id('artifact', String(i)),
    path: `src/${'nested/'.repeat(45)}cache-${i}.ts`,
  }));
  for (let i = 0; i < 320; i++) {
    assert.equal(logger.record(value), true);
    if (i % 8 === 7) await logger.flush();
  }
  await logger.close();
  assert.ok(logger.stats().rotations >= 3);
  for (const filename of [logger.stats().logPath, logger.stats().backupPath]) {
    const stat = await fs.stat(filename);
    assert.ok(stat.size <= DIAGNOSTIC_LIMITS.fileBytes);
    assert.equal(stat.mode & 0o777, 0o600);
    for (const line of (await fs.readFile(filename, 'utf8')).trim().split('\n')) JSON.parse(line);
  }
  assert.deepEqual((await fs.readdir(paths.directory)).filter(name => name.startsWith('diagnostics')).sort(),
    ['diagnostics.1.jsonl', 'diagnostics.jsonl']);
  const restored = await readPersistedDiagnostics(paths);
  assert.equal(restored.records.at(-1).seq, 320);
  assert.ok(restored.records.every((entry, i, rows) => !i || rows[i - 1].seq < entry.seq));
});

test('slow persistence never blocks record intake and the whole pending queue stays bounded', async t => {
  const { projectRoot, logger } = await setupLogger(t);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (filename, flags, ...args) => {
    if (filename === logger.stats().logPath) { entered(); await blocked; }
    return originalOpen(filename, flags, ...args);
  });
  syncBuiltinESMExports();
  try {
    logger.record(record(projectRoot));
    const flushing = logger.flush();
    await started;
    for (let i = 0; i < 1200; i++) assert.equal(logger.record(record(projectRoot)), true);
    assert.ok(logger.stats().pendingBytes <= DIAGNOSTIC_LIMITS.pendingBytes);
    assert.ok(logger.stats().dropped > 0);
    assert.equal(logger.snapshot().records.at(-1).seq, 1201);
    release();
    await flushing;
    assert.equal(logger.stats().pendingBytes, 0);
    assert.ok(logger.stats().written > 1);
  } finally {
    release();
    await logger.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('records queued during drain settlement are written before concurrent flush or close returns', async t => {
  for (const finish of ['flush', 'close']) {
    const { projectRoot, logger } = await setupLogger(t);
    // The empty inner drain has settled, but its cleanup continuation has not
    // run yet. No later record or timer should be needed to persist this entry.
    const firstFlush = logger.flush();
    assert.equal(logger.record(record(projectRoot)), true);
    assert.ok(logger.stats().pendingBytes > 0);
    const completion = logger[finish]();
    await Promise.all([firstFlush, completion]);
    assert.equal(logger.stats().pendingBytes, 0, `${finish} waits for the handoff record`);
    assert.equal(logger.stats().written, 1);
    const lines = (await fs.readFile(logger.stats().logPath, 'utf8')).trim().split('\n');
    assert.deepEqual(lines.map(line => JSON.parse(line).seq), [1]);
  }
});

test('unsafe destination files fail quietly without changing targets and recovery accepts later records', async t => {
  const { base, projectRoot, paths, logger } = await setupLogger(t);
  const target = path.join(base, 'unrelated');
  await fs.writeFile(target, 'DO_NOT_OVERWRITE');
  await fs.symlink(target, logger.stats().logPath);
  logger.record(record(projectRoot));
  await logger.flush();
  assert.equal(logger.stats().persistenceFailures, 1);
  assert.equal(logger.snapshot().records.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'DO_NOT_OVERWRITE');
  assert.equal((await readPersistedDiagnostics(paths)).stats.readFailures, 1);
  await fs.rm(logger.stats().logPath);
  logger.record(record(projectRoot));
  await logger.flush();
  assert.equal(logger.stats().written, 1);
  assert.equal(JSON.parse((await fs.readFile(logger.stats().logPath, 'utf8')).trim()).seq, 2);
});

test('hard-linked and public log files are refused, including a rotation backup', async t => {
  const { base, projectRoot, paths, logger } = await setupLogger(t, { persistEvidence: true });
  const target = path.join(base, 'untouched');
  await fs.writeFile(target, 'PRIVATE_TARGET', { mode: 0o600 });
  await fs.link(target, logger.stats().logPath);
  logger.record(record(projectRoot)); await logger.flush();
  assert.equal(logger.stats().persistenceFailures, 1);
  assert.equal((await readPersistedDiagnostics(paths)).stats.readFailures, 1);
  await fs.rm(logger.stats().logPath);
  await fs.writeFile(logger.stats().logPath, '', { mode: 0o644 });
  logger.record(record(projectRoot)); await logger.flush();
  assert.equal(logger.stats().persistenceFailures, 2);
  await fs.chmod(logger.stats().logPath, 0o600);
  await fs.writeFile(logger.stats().logPath, ' '.repeat(DIAGNOSTIC_LIMITS.fileBytes));
  await fs.symlink(target, logger.stats().backupPath);
  logger.record(record(projectRoot)); await logger.flush();
  assert.equal(logger.stats().persistenceFailures, 3);
  assert.equal(await fs.readFile(target, 'utf8'), 'PRIVATE_TARGET');
});

test('a partial crash tail is discarded before subsequent writes and oversized input stays bounded', async t => {
  const { projectRoot, paths, logger } = await setupLogger(t);
  logger.record(record(projectRoot)); await logger.close();
  await fs.appendFile(logger.stats().logPath, '{"schemaVersion":1,"partial":');
  const reopened = await createDiagnostics(paths);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().records.length, 1);
  const large = record(projectRoot);
  large.artifacts = Array.from({ length: 1000 }, (_, i) => ({
    ...large.artifacts[0], artifactId: id('artifact', String(i)), path: `${'x'.repeat(490)}/${i}.ts`,
  }));
  large.candidates = Array.from({ length: 1000 }, (_, i) => ({ ...large.candidates[0], candidateId: id('candidate', String(i)) }));
  large.diagnostics.trace = { version: 1, intake: Array(10000).fill({ reason: 'approved', approved: true }) };
  reopened.record(large); await reopened.close();
  const restored = await readPersistedDiagnostics(paths);
  assert.deepEqual(restored.records.map(row => row.seq), [1, 2]);
  assert.equal(restored.records[1].artifacts.length, 32);
  assert.equal(restored.records[1].candidates.length, 12);
  assert.equal(restored.records[1].diagnostics.trace.intake.length, 12);
  assert.equal(restored.stats.invalidRecords, 0);
});
