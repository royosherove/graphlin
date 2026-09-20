import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths, atomicJSON, PROTOCOL } from '../../runtime/daemon/paths.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';
import { health } from '../../runtime/daemon/lock.mjs';
import { diagnosticLogs, daemonStatus } from '../../runtime/daemon/manager.mjs';
import { createDiagnostics, diagnosticArtifactId, DIAGNOSTIC_LIMITS } from '../../runtime/daemon/diagnostics.mjs';
import { createDecisionService, createFixtureTransport } from '../../runtime/jev/index.mjs';
import { ACTIVITIES, ROLES } from '../../runtime/jev/questions.mjs';
import { parseArguments } from '../../scripts/arguments.mjs';
import { workspace, authenticate, run } from './helpers.mjs';

const cli = fileURLToPath(new URL('../../scripts/graphlin.mjs', import.meta.url));
const noRemote = () => ({ classify() { throw new Error('unexpected_call'); }, stats: () => ({ calls: 0 }), close() {} });

test('diagnostics require browser auth and local origin, and reject IPC callers without the exact owner', async t => {
  const setup = await workspace(t);
  const server = await startServer({ ...setup, decisionService: noRemote() });
  t.after(() => server.close());
  const { origin, cookie } = await authenticate(server), route = origin + '/api/diagnostics';
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  const wrongHost = await new Promise(resolve => {
    http.get(route, { headers: { Cookie: cookie, Host: 'evil.example' } },
      response => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(route + '?file=cache.ts', { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(route, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 404);
  const response = await fetch(route, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const envelope = await response.json();
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.source, 'live');
  assert.ok(Array.isArray(envelope.records));
  const paths = await projectPaths(setup.projectRoot, setup.dataDir), owner = await health(paths);
  assert.equal((await requestIPC(paths.socket, { op: 'diagnostics' })).code, 'wrong_instance');
  assert.equal((await requestIPC(paths.socket, { op: 'diagnostics', instanceId: 'wrong' })).code, 'wrong_instance');
  assert.equal((await requestIPC(paths.socket, { op: 'diagnostics', instanceId: owner.instanceId, raw: 'forbidden' })).code, 'invalid_input');
  assert.equal((await requestIPC(paths.socket, { op: 'diagnostics', instanceId: owner.instanceId, artifactId: 'cache.ts' })).code, 'invalid_input');
  const ipc = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: owner.instanceId });
  assert.deepEqual(ipc.records, envelope.records);
  assert.equal(ipc.logPath, envelope.logPath);
  assert.equal(owner.logPath, envelope.logPath);
  assert.equal((await daemonStatus(setup)).logPath, envelope.logPath);
});

test('real offline two-pass classification preserves all 12 candidate traces through authenticated HTTP, IPC, CLI and stopped logs', async t => {
  const setup = await workspace(t), filename = path.join(setup.projectRoot, 'cache.ts');
  const names = Array.from({ length: 12 }, (_, i) => `cache${String(i).padStart(2, '0')}`);
  await writeFile(filename, names.map((name, i) => `export function ${name}() { return ${i}; }`).join('\n'));
  const fixture = createFixtureTransport({ mode: 'demo', activity: 'implement',
    candidates: Object.fromEntries(names.map((name, i) => [name, {
      role: 'function', relevant: 0.98, sensitive: 0.01,
      // Tentative nodes exercise finite rejection reasons, alongside accepted ones.
      support: i % 2 ? 0.6 : 0.97,
    }])),
  });
  const service = createDecisionService({ fetchImpl: fixture });
  const results = [];
  const server = await startServer({ ...setup, mode: 'demo', policy: { transmitSource: true },
    decisionService: { ...service, async classify(value) {
      const result = await service.classify(value); results.push(result); return result;
    } } });
  t.after(() => server.close());
  const { origin, cookie, token } = await authenticate(server);
  await server.pipeline.ingest({ cwd: setup.projectRoot, hook_event_name: 'PostToolUse',
    session_id: 'offline-diagnostics', tool_name: 'Write', tool_use_id: 'cache-write',
    tool_input: { file_path: filename, content: 'RAW_TOOL_CONTENT_MUST_NOT_BE_LOGGED' },
    tool_response: { success: true, stdout: 'RAW_TOOL_RESULT_MUST_NOT_BE_LOGGED' },
  }, { host: 'claude' });
  await server.pipeline.whenIdle();
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const artifactId = diagnosticArtifactId(paths.projectRoot, 'cache.ts');
  const http = await (await fetch(origin + '/api/diagnostics', { headers: { Cookie: cookie } })).json();
  const completed = http.records.find(row => row.stage === 'classification' && row.status === 'accepted');
  assert.ok(completed, JSON.stringify(http));
  assert.equal(results.length, 1);
  assert.equal(completed.candidates.length, 12);
  assert.equal(completed.diagnostics.trace.intake.length, 12);
  assert.deepEqual(completed.diagnostics.trace, results[0].diagnostics.trace);
  assert.equal(completed.diagnostics.trace.activity.choice, 'implement');
  assert.ok(completed.diagnostics.trace.activity.confidence >= 0 && completed.diagnostics.trace.activity.confidence <= 1);
  assert.deepEqual(Object.keys(completed.diagnostics.trace.activity.probabilities).sort(), [...ACTIVITIES].sort());
  assert.ok(Object.values(completed.diagnostics.trace.activity.probabilities).every(value => value >= 0 && value <= 1));
  for (const node of completed.diagnostics.trace.nodes) {
    assert.deepEqual(Object.keys(node.roleProbabilities).sort(), [...ROLES].sort());
    assert.ok(Object.values(node.roleProbabilities).every(value => value >= 0 && value <= 1));
  }
  assert.equal(completed.diagnostics.trace.requests.length, 2);
  assert.deepEqual(completed.diagnostics.trace.requests.map(row => row.stage), ['A', 'B']);
  assert.ok(completed.diagnostics.trace.requests.every(row => row.durationMs >= 0 && row.model.startsWith('jev-') &&
    /^(intake|architecture)-v\d+$/.test(row.rubricVersion) && row.dispatched === true));
  assert.equal(completed.diagnostics.trace.thresholds.intake.sensitiveMax, 0.1);
  assert.equal(completed.diagnostics.trace.thresholds.admission.nodeSupportMin, 0.85);
  assert.ok(completed.diagnostics.trace.nodes.some(row => row.reasons.includes('node_support_below_min')));
  assert.ok(http.records.some(row => row.stage === 'classification' && row.status === 'started'));
  assert.ok(http.records.some(row => row.stage === 'apply' && row.patch.nodesAdded > 0));
  assert.equal(http.stats.dropped, 0);
  assert.equal(http.stats.truncated, 0);
  assert.equal(http.stats.invalidRecords, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(completed)) < DIAGNOSTIC_LIMITS.recordBytes);
  const current = await health(paths);
  const ipc = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: current.instanceId, artifactId },
    { maxResponseBytes: DIAGNOSTIC_LIMITS.ringBytes + 64 * 1024 });
  const fromCLI = await run(process.execPath, [cli, 'logs', '--project', setup.projectRoot,
    '--data-dir', setup.dataDir, '--file', 'cache.ts']);
  assert.equal(fromCLI.code, 0, fromCLI.stderr);
  const cliEnvelope = JSON.parse(fromCLI.stdout);
  assert.equal(cliEnvelope.schemaVersion, 1);
  assert.deepEqual(cliEnvelope.records, ipc.records);
  assert.deepEqual(cliEnvelope.records.find(row => row.id === completed.id).diagnostics.trace, results[0].diagnostics.trace);
  assert.equal(cliEnvelope.logPath, current.logPath);
  for (const body of [JSON.stringify(http), JSON.stringify(ipc), fromCLI.stdout]) {
    assert.doesNotMatch(body, /RAW_TOOL_CONTENT|RAW_TOOL_RESULT|export function/);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes(cookie.split('=')[1]), false);
  }
  await server.close();
  await rm(filename);
  const alias = path.join(setup.base, 'project alias');
  await symlink(setup.projectRoot, alias);
  const stopped = await run(process.execPath, [cli, 'logs', '--project', alias,
    '--data-dir', setup.dataDir, '--file', path.join(alias, 'cache.ts')]);
  assert.equal(stopped.code, 0, stopped.stderr);
  const persisted = JSON.parse(stopped.stdout);
  assert.equal(persisted.source, 'persisted');
  assert.deepEqual(persisted.records.find(row => row.id === completed.id).diagnostics.trace, results[0].diagnostics.trace);
  assert.ok(persisted.records.every(row => row.artifacts.every(artifact => artifact.path === undefined) &&
    row.candidates.every(candidate => candidate.label === undefined)));
  assert.equal((await daemonStatus(setup)).logPath, current.logPath);
});

test('metadata-only capture logs its reason without invoking classification or copying prompt text', async t => {
  const setup = await workspace(t), service = noRemote();
  const server = await startServer({ ...setup, decisionService: service });
  t.after(() => server.close());
  await server.pipeline.ingest({ cwd: setup.projectRoot, hook_event_name: 'UserPromptSubmit',
    session_id: 'metadata-only', prompt: 'RAW_PROMPT_NEVER_IN_DIAGNOSTICS' }, { host: 'claude' });
  await server.pipeline.whenIdle();
  const logs = await diagnosticLogs(setup);
  assert.ok(logs.records.some(row => row.reason === 'metadata_only'));
  assert.equal(logs.records.filter(row => row.stage === 'classification').length, 0);
  assert.doesNotMatch(JSON.stringify(logs), /RAW_PROMPT_NEVER|metadata-only/);
});

test('metadata-only restart cannot expose names from a previously opted-in log over HTTP or CLI', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  const seed = await createDiagnostics({ ...paths,
    policy: { transmitSource: true, displayEvidence: true, persistEvidence: true } });
  seed.record({ schemaVersion: 1, stage: 'capture', status: 'observed', reason: 'artifacts_observed',
    artifacts: [{ artifactId: diagnosticArtifactId(paths.projectRoot, 'cache.ts'), path: 'cache.ts',
      status: 'present', complete: true }] });
  await seed.close();
  const server = await startServer({ ...setup, policy: { transmitSource: false, displayEvidence: true },
    decisionService: noRemote() });
  t.after(() => server.close());
  const { origin, cookie } = await authenticate(server);
  const response = await fetch(origin + '/api/diagnostics', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const logs = await response.json();
  assert.ok(logs.records.some(row => row.artifacts.length > 0));
  assert.doesNotMatch(JSON.stringify(logs), /cache\.ts/);
  const result = await run(process.execPath, [cli, 'logs', '--project', setup.projectRoot,
    '--data-dir', setup.dataDir, '--file', 'cache.ts']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).records.length, 1);
  assert.doesNotMatch(result.stdout, /cache\.ts/);
});

test('logs reports restart_required for a healthy older daemon instead of pretending the log is empty', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  await mkdir(paths.lock, { mode: 0o700 });
  const owner = { protocol: PROTOCOL, projectId: paths.projectId, pid: process.pid, instanceId: 'older-instance' };
  await atomicJSON(path.join(paths.lock, 'owner.json'), owner, 4096);
  const operations = [];
  const ipc = net.createServer(socket => {
    let body = '';
    socket.on('data', chunk => {
      body += chunk;
      if (!body.includes('\n')) return;
      const input = JSON.parse(body.trim()); operations.push(input.op);
      socket.end(JSON.stringify(input.op === 'health' ? { ok: true, ...owner }
        : { ok: false, code: 'invalid_operation' }) + '\n');
    });
  });
  await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(paths.socket, resolve); });
  try {
    await assert.rejects(diagnosticLogs(setup), { code: 'restart_required' });
    const result = await run(process.execPath, [cli, 'logs', '--project', setup.projectRoot, '--data-dir', setup.dataDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /restart_required/);
    assert.equal(result.stdout, '');
    assert.deepEqual(operations, ['health', 'diagnostics', 'health', 'diagnostics']);
  } finally {
    await new Promise(resolve => ipc.close(resolve));
    await rm(paths.lock, { recursive: true, force: true });
  }
});

test('logs --file is isolated to retrieval and stopped empty projects return a bounded valid envelope', async t => {
  const setup = await workspace(t);
  assert.equal(parseArguments(['logs', '--file', 'cache.ts']).file, 'cache.ts');
  for (const command of ['start', 'stop', 'demo', 'status', 'doctor', 'export']) {
    assert.throws(() => parseArguments([command, '--file', 'cache.ts']), /unknown_argument/);
  }
  assert.throws(() => parseArguments(['--file', 'cache.ts'], { worker: true }), /unknown_argument/);
  const result = await run(process.execPath, [cli, 'logs', '--project', setup.projectRoot, '--data-dir', setup.dataDir]);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.source, 'persisted');
  assert.deepEqual(envelope.records, []);
  assert.equal(envelope.stats.readFailures, 0);
  const outside = await run(process.execPath, [cli, 'logs', '--project', setup.projectRoot,
    '--data-dir', setup.dataDir, '--file', '../outside.ts']);
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /invalid_log_filter/);
});
