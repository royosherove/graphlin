import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, run } from './helpers.mjs';
import { saveSettings, readSettings } from '../../runtime/daemon/settings.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { runForeground, daemonStatus, startDaemon, stopDaemon } from '../../runtime/daemon/manager.mjs';
import { startServer } from '../../runtime/daemon/server.mjs';
import { createDiagnostics, readPersistedDiagnostics } from '../../runtime/daemon/diagnostics.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';
import { health } from '../../runtime/daemon/lock.mjs';
import {
  resolveProviderConfig, deciderConfig, providerArguments, providerFromArguments, DEFAULT_DECIDER_MODEL,
  DECIDER_LIMITS, DECIDER_INTAKE_POLICY, JEV_PROVIDER, createConfiguredProvider,
} from '../../runtime/daemon/providers.mjs';
import { fakeDeciderServer, deciderAnswer } from '../decider/fake-server.mjs';
import { jsonResponse } from '../jev/helpers.mjs';

// The daemons in this file get a decider endpoint on the discard port, and an
// empty project makes no decision request. Only the composition-root test
// sends a synthetic request, to a fake Decider server on 127.0.0.1.
const decider = Object.freeze({ id: 'decider', endpoint: 'http://127.0.0.1:9/v1/systemone', model: DEFAULT_DECIDER_MODEL });
const described = { ...decider, experimental: true };
const consent = { allowSource: true, persistEvidence: false, displayEvidence: true };
const key = 'SYNTHETIC_DECIDER_TEST_KEY';
// The decision service of a decider daemon: these values come from the
// service that the composition root made, not from the configuration.
const deciderService = { provider: { id: 'decider', version: '1' }, model: DEFAULT_DECIDER_MODEL,
  limits: { concurrency: DECIDER_LIMITS.concurrency, eventDeadlineMs: DECIDER_LIMITS.eventDeadlineMs,
    maxCandidates: DECIDER_LIMITS.maxCandidates, maxRequestBytes: DECIDER_LIMITS.maxRequestBytes },
  intakePolicyVersion: 'intake-policy-v1-decider-experimental',
  admissionPolicyVersion: 'admission-policy-v1-decider-experimental' };
const jevService = { provider: { id: 'jev', version: '1' }, model: 'jev-1.13.0',
  limits: { concurrency: 2, eventDeadlineMs: 5000, maxCandidates: 12, maxRequestBytes: 65536 },
  intakePolicyVersion: 'intake-policy-v1', admissionPolicyVersion: 'admission-policy-v1' };
// The exact decider intake policy. The tests of the doctor output and the
// graphlin provider output use these literal values, not the module value.
const deciderIntakePolicy = Object.freeze({
  version: 'intake-policy-v1-decider-experimental', relevantMin: 0.5, sensitiveMax: 0.16 });

async function deciderSetup(t, extra = {}) {
  const setup = await workspace(t);
  await saveSettings(setup, { policy: consent, decisionProvider: decider, ...extra });
  return setup;
}

function cli(setup, args, env = {}) {
  const childEnv = { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir, ...env };
  delete childEnv.TYPESAFE_API_KEY;
  return run(process.execPath, ['scripts/graphlin.mjs', ...args, '--project', setup.projectRoot], { env: childEnv });
}

test('provider configuration resolves only from valid values and never falls back to Jev', () => {
  assert.deepEqual(resolveProviderConfig(undefined), { id: 'jev' });
  assert.deepEqual(resolveProviderConfig({ id: 'jev' }), { id: 'jev' });
  assert.deepEqual(resolveProviderConfig(decider), decider);
  assert.deepEqual(deciderConfig(), { id: 'decider', endpoint: 'http://127.0.0.1:8099/v1/systemone', model: DEFAULT_DECIDER_MODEL });
  for (const value of [
    { id: 'decider' }, { id: 'decider', endpoint: 'http://localhost:8099/v1/systemone', model: DEFAULT_DECIDER_MODEL },
    { id: 'decider', endpoint: 'http://[::1]:8099/v1/systemone', model: DEFAULT_DECIDER_MODEL },
    { ...decider, extra: true }, { id: 'jev', endpoint: decider.endpoint }, { id: 'other' }, 'decider', [],
  ]) assert.throws(() => resolveProviderConfig(value), { code: 'invalid_provider' });
  assert.deepEqual(providerFromArguments({}), { id: 'jev' });
  assert.deepEqual(providerFromArguments({ provider: 'decider', deciderEndpoint: decider.endpoint,
    deciderModel: decider.model }), decider);
  assert.throws(() => providerFromArguments({ deciderEndpoint: decider.endpoint }), { code: 'invalid_provider' });
  assert.deepEqual(providerArguments({ id: 'jev' }), []);
  assert.deepEqual(providerArguments(decider), ['--provider', 'decider', '--decider-endpoint', decider.endpoint,
    '--decider-model', decider.model]);
});

test('every settings write keeps the saved provider; Jev removes it', async t => {
  const setup = await deciderSetup(t, { apiKey: key });
  await saveSettings(setup, { installation: { hosts: ['claude'], version: '0.1.0' } });
  assert.deepEqual((await readSettings(setup)).decisionProvider, decider);
  await saveSettings(setup, { apiKey: 'SYNTHETIC_REPLACED_KEY' });
  assert.deepEqual((await readSettings(setup)).decisionProvider, decider);
  await saveSettings(setup, { apiKey: null });
  await saveSettings(setup, { policy: { ...consent, allowSource: false } });
  assert.deepEqual((await readSettings(setup)).decisionProvider, decider);
  await assert.rejects(saveSettings(setup, { decisionProvider: { id: 'decider', endpoint: 'http://localhost:1/v1/systemone',
    model: DEFAULT_DECIDER_MODEL } }), { code: 'invalid_settings' });
  await saveSettings(setup, { decisionProvider: null });
  const file = JSON.parse(await readFile(path.join(setup.dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['installation', 'schemaVersion'],
    'with Jev, an older Graphlin can read the file again');
});

test('a saved provider that is not valid stops every start path (fail closed)', async t => {
  const setup = await deciderSetup(t);
  const filename = path.join(setup.dataDir, 'settings.json');
  const file = JSON.parse(await readFile(filename, 'utf8'));
  file.decisionProvider = { ...decider, endpoint: 'http://localhost:8099/v1/systemone' };
  await writeFile(filename, JSON.stringify(file), { mode: 0o600 });
  await assert.rejects(readSettings(setup), { code: 'unsafe_settings' });
  await assert.rejects(startDaemon(setup), { code: 'unsafe_settings' });
  await assert.rejects(runForeground({ ...setup, signal: new AbortController().signal }), { code: 'unsafe_settings' });
  assert.equal((await daemonStatus(setup)).running, false, 'no daemon falls back to Jev');
  // The composition root and the worker refuse a bad plain configuration too.
  await assert.rejects(startServer({ ...setup, provider: { id: 'decider', endpoint: 'http://10.0.0.1/v1/systemone',
    model: DEFAULT_DECIDER_MODEL } }), { code: 'invalid_provider' });
  const worker = await run(process.execPath, ['scripts/daemon.mjs', '--project', setup.projectRoot, '--data-dir',
    setup.dataDir, '--mode', 'live', '--provider', 'decider', '--decider-endpoint', 'http://localhost:8099/v1/systemone',
    '--decider-model', DEFAULT_DECIDER_MODEL]);
  assert.equal(worker.code, 1);
  assert.equal((await daemonStatus(setup)).running, false);
  // Doctor does not guess Jev, and the CLI names the file and the keys.
  let result = await cli(setup, ['doctor'], { PATH: setup.base });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.settings, 'unsafe_settings');
  assert.equal(report.provider, 'unknown');
  assert.equal(report.credential, 'unknown');
  assert.equal(report.nextActions.some(action => /TypeSafe key|experimental|tunnel/.test(action)), false);
  assert.ok(report.nextActions.some(action => /settings\.json/.test(action) && /decisionProvider/.test(action)));
  result = await cli(setup, ['provider']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsafe_settings\. Examine settings\.json in the Graphlin data directory/);
  assert.match(result.stderr, /apiKey, installation and decisionProvider/);
  assert.doesNotMatch(result.stderr, /localhost/, 'the file content is not shown');
  // graphlin provider jev removes the value that is not valid and keeps the other keys.
  result = await cli(setup, ['provider', 'jev']);
  assert.equal(result.code, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.deepEqual(shown.provider, { id: 'jev' });
  assert.equal(shown.removedInvalidValue, true);
  assert.match(shown.note, /all projects that use this Graphlin data directory/);
  const repaired = await readSettings(setup);
  assert.equal(repaired.decisionProvider, undefined);
  assert.deepEqual(repaired.policy, consent);
});

test('graphlin provider jev does not change a settings file with another key that is not valid', async t => {
  const setup = await deciderSetup(t);
  const filename = path.join(setup.dataDir, 'settings.json');
  const file = JSON.parse(await readFile(filename, 'utf8'));
  file.decisionProvider = { id: 'other' };
  file.apiKey = 'SYNTHETIC BAD KEY';
  await writeFile(filename, JSON.stringify(file), { mode: 0o600 });
  const before = await readFile(filename, 'utf8');
  const result = await cli(setup, ['provider', 'jev']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsafe_settings/);
  assert.doesNotMatch(result.stderr, /SYNTHETIC BAD KEY/);
  assert.equal(await readFile(filename, 'utf8'), before);
});

// The decider server accepts only the Host 127.0.0.1 (or localhost), thus an
// [::1] endpoint cannot work. A saved [::1] value stops each start with
// invalid_provider, and the hint names the repair command.
test('a saved [::1] decider endpoint stops each start with invalid_provider and names the repair', async t => {
  const setup = await deciderSetup(t);
  const filename = path.join(setup.dataDir, 'settings.json');
  const file = JSON.parse(await readFile(filename, 'utf8'));
  file.decisionProvider = { ...decider, endpoint: 'http://[::1]:9/v1/systemone' };
  await writeFile(filename, JSON.stringify(file), { mode: 0o600 });
  await assert.rejects(startDaemon(setup), { code: 'invalid_provider' });
  await assert.rejects(runForeground({ ...setup, signal: new AbortController().signal }), { code: 'invalid_provider' });
  assert.equal((await daemonStatus(setup)).running, false, 'no daemon starts, and no fallback to Jev');
  await assert.rejects(startServer({ ...setup, provider: file.decisionProvider }), { code: 'invalid_provider' });
  let result = await cli(setup, ['provider']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid_provider\. The decider endpoint must be http:\/\/127\.0\.0\.1:<port>\/v1\/systemone/);
  assert.match(result.stderr, /graphlin provider decider/);
  assert.match(result.stderr, /graphlin provider jev/);
  result = await cli(setup, ['doctor'], { PATH: setup.base });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provider, 'invalid_provider');
  assert.equal(report.credential, 'unknown');
  assert.ok(report.nextActions.some(action => /graphlin provider decider/.test(action)), JSON.stringify(report.nextActions));
  // The repair command saves the default endpoint and keeps the other keys.
  result = await cli(setup, ['provider', 'decider']);
  assert.equal(result.code, 0, result.stderr);
  const repaired = await readSettings(setup);
  assert.equal(repaired.decisionProvider.endpoint, 'http://127.0.0.1:8099/v1/systemone');
  assert.deepEqual(repaired.policy, consent);
});

test('graphlin provider jev does not change the user file when the project file is not valid', async t => {
  const setup = await deciderSetup(t);
  const filename = path.join(setup.dataDir, 'settings.json');
  const before = await readFile(filename, 'utf8');
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const projectFile = path.join(paths.directory, 'settings.json');
  const project = JSON.parse(await readFile(projectFile, 'utf8'));
  project.unknownKey = true;
  await writeFile(projectFile, JSON.stringify(project), { mode: 0o600 });
  const result = await cli(setup, ['provider', 'jev']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsafe_settings/);
  assert.equal(await readFile(filename, 'utf8'), before, 'the user file keeps the decider value');
});

test('default foreground start runs decider in process, needs no key, and requires a restart for a provider change', async t => {
  const setup = await deciderSetup(t);
  const controller = new AbortController();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const task = runForeground({ ...setup, signal: controller.signal }, readyResolve);
  t.after(() => controller.abort());
  try {
    const started = await ready;
    assert.deepEqual(started.provider, described);
    assert.deepEqual(started.decisionService, deciderService);
    assert.equal(started.policy.transmitSource, true);
    assert.notEqual(started.status.classifier, 'missing_key');
    assert.equal(started.status.calls, 0, 'no request without observations');
    const reused = await startDaemon(setup);
    assert.equal(reused.instanceId, started.instanceId);
    await saveSettings(setup, { decisionProvider: null });
    await assert.rejects(startDaemon(setup), { code: 'provider_restart_required' });
    await saveSettings(setup, { decisionProvider: { ...decider, model: 'strands-decider-other' } });
    await assert.rejects(startDaemon(setup), { code: 'provider_restart_required' });
    assert.equal((await daemonStatus(setup)).instanceId, started.instanceId);
  } finally { controller.abort(); await task; }
});

test('background worker gets decider as worker arguments and never inherits the Jev key', async t => {
  const setup = await deciderSetup(t);
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = key;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  const started = await startDaemon(setup);
  assert.deepEqual(started.provider, described);
  assert.deepEqual(started.decisionService, deciderService);
  assert.notEqual(started.status.classifier, 'missing_key');
  assert.equal(JSON.stringify(started).includes(key), false);
  if (process.platform === 'linux') {
    const environ = await readFile(`/proc/${started.pid}/environ`, 'utf8');
    assert.equal(environ.split('\0').some(entry => entry.startsWith('TYPESAFE_API_KEY=')), false);
    const argv = (await readFile(`/proc/${started.pid}/cmdline`, 'utf8')).split('\0');
    assert.deepEqual(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 6), providerArguments(decider));
  }
  await saveSettings(setup, { decisionProvider: null });
  await assert.rejects(startDaemon(setup), { code: 'provider_restart_required' });
  await stopDaemon(setup);
  // After the stop, the same start path makes a Jev daemon from the saved settings.
  const jev = await startDaemon(setup);
  assert.deepEqual(jev.provider, { id: 'jev' });
  assert.deepEqual(jev.decisionService, jevService);
  await stopDaemon(setup);
});

test('MCP start uses the saved decider provider', async t => {
  const setup = await deciderSetup(t);
  const env = { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir, TYPESAFE_API_KEY: key };
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start', arguments: { projectRoot: setup.projectRoot } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stop', arguments: { projectRoot: setup.projectRoot } } },
  ];
  const result = await run(process.execPath, ['scripts/control.mjs'], {
    env, input: messages.map(value => JSON.stringify(value)).join('\n') + '\n',
  });
  assert.equal(result.code, 0, result.stderr);
  const started = JSON.parse(JSON.parse(result.stdout.split('\n')[1]).result.content[0].text);
  assert.deepEqual(started.provider, described);
  assert.deepEqual(started.decisionService, deciderService);
  assert.equal(started.policy.transmitSource, true);
  assert.equal(result.stdout.includes(key), false);
});

test('the composition root sends a decider request to the endpoint, with no key, under the decider policy', async t => {
  const setup = await workspace(t);
  const fake = await fakeDeciderServer(t);
  const filename = path.join(setup.projectRoot, 'notes.js');
  await writeFile(filename, 'export function saveNote(note) { return db.insert(note); }\n');
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = key;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  const server = await startServer({ ...setup, mode: 'live', provider: deciderConfig({ endpoint: fake.endpoint }),
    apiKey: key, policy: { readSource: true, transmitSource: true, displayEvidence: true, persistEvidence: false } });
  t.after(() => server.close());
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const current = await health(paths);
  assert.deepEqual(current.decisionService, { ...deciderService });
  await server.pipeline.ingest({ cwd: setup.projectRoot, hook_event_name: 'PostToolUse',
    session_id: 'synthetic-decider', tool_name: 'Write', tool_use_id: 'decider-write',
    tool_input: { file_path: filename }, tool_response: { success: true } }, { host: 'claude' });
  await server.pipeline.whenIdle();
  assert.ok(fake.requests.length >= 1, 'the fake Decider server gets the request');
  for (const request of fake.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/systemone');
    assert.equal(request.headers.authorization, undefined, 'no authorization header');
    assert.equal(request.body.includes(key), false, 'the Jev key never goes to the decider');
    assert.equal(JSON.parse(request.body).model, DEFAULT_DECIDER_MODEL);
  }
  const logs = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: current.instanceId });
  const decisions = logs.records.filter(row => row.diagnostics?.admissionPolicyVersion);
  assert.ok(decisions.length >= 1, JSON.stringify(logs.records.map(row => [row.stage, row.status, row.reason])));
  for (const decision of decisions) {
    assert.equal(decision.diagnostics.provider, 'decider');
    assert.equal(decision.diagnostics.admissionPolicyVersion, 'admission-policy-v1-decider-experimental');
    assert.ok(decision.diagnostics.trace.requests.every(row => row.model === DEFAULT_DECIDER_MODEL));
  }
  assert.ok(decisions.some(row => row.diagnostics.trace.requests.some(entry => entry.dispatched)));
});

// A Postgres write through the real composition root. Stage A gets
// the given intake scores. Stage B supports only the writes relation.
const postgresWrite = 'import { Pool } from "pg";\nconst db = new Pool();\n'
  + 'export function saveNote(body) {\n  return db.query("INSERT INTO notes (body) VALUES ($1)", [body]);\n}\n';
function intakeAnswers(request, { sensitive, relevant }) {
  const answer = deciderAnswer(request);
  for (const [id, value] of Object.entries(answer.answers)) {
    if (id.startsWith('a_sensitive_')) value.noul = sensitive;
    else if (id.startsWith('a_relevant_')) value.noul = relevant;
    else if (id.startsWith('b_relation_')) {
      value.noul = request.state.proposals[Number(id.slice('b_relation_'.length))].relation === 'writes' ? 0.97 : 0.02;
    }
  }
  return answer;
}
async function intakeRun(t, { provider = 'decider', sensitive, relevant = 0.85 }) {
  const setup = await workspace(t);
  const filename = path.join(setup.projectRoot, 'notes.js');
  await writeFile(filename, postgresWrite);
  const scores = { sensitive, relevant };
  let options;
  if (provider === 'decider') {
    const fake = await fakeDeciderServer(t, (entry, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(intakeAnswers(JSON.parse(entry.body), scores)));
    });
    options = { provider: deciderConfig({ endpoint: fake.endpoint }) };
  } else {
    // Jev gets the same literal answers through a local transport. No request leaves the process.
    const fetchImpl = async (_url, init) => jsonResponse({ ...intakeAnswers(JSON.parse(init.body), scores), model: 'jev-1.13.0' });
    options = { decisionProvider: createConfiguredProvider(JEV_PROVIDER, { apiKey: key, fetchImpl }) };
  }
  const server = await startServer({ ...setup, mode: 'live', ...options,
    policy: { readSource: true, transmitSource: true, displayEvidence: true, persistEvidence: false } });
  t.after(() => server.close());
  await server.pipeline.ingest({ cwd: setup.projectRoot, hook_event_name: 'PostToolUse',
    session_id: 'synthetic-intake', tool_name: 'Write', tool_use_id: 'intake-write',
    tool_input: { file_path: filename }, tool_response: { success: true } }, { host: 'claude' });
  await server.pipeline.whenIdle();
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const current = await health(paths);
  const logs = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: current.instanceId });
  const graph = server.pipeline.getState().graph;
  const label = new Map(graph.nodes.map(node => [node.id, node.label]));
  return { current, graph, nodes: graph.nodes.map(node => node.label),
    edges: graph.edges.map(edge => [label.get(edge.source), edge.relation, label.get(edge.target)]),
    decisions: logs.records.filter(row => row.diagnostics?.intakePolicyVersion) };
}

// The intake tests below follow DECIDER_INTAKE_POLICY. This test asserts the
// exact values, thus an accidental change of a value makes a test fail.
test('the decider intake policy is sensitiveMax 0.16 and relevantMin 0.5 with its experimental version', () => {
  assert.deepEqual({ ...DECIDER_INTAKE_POLICY }, { ...deciderIntakePolicy });
  assert.equal(DECIDER_INTAKE_POLICY.sensitiveMax, 0.16);
  assert.equal(DECIDER_INTAKE_POLICY.relevantMin, 0.5);
  assert.equal(DECIDER_INTAKE_POLICY.version, 'intake-policy-v1-decider-experimental');
});

test('decider intake: sensitive below the decider sensitiveMax gives the writes edge of a Postgres write', async t => {
  const run = await intakeRun(t, { sensitive: DECIDER_INTAKE_POLICY.sensitiveMax - 0.02 });
  assert.deepEqual(run.edges, [['saveNote', 'writes', 'db']], JSON.stringify(run.decisions.map(row => row.diagnostics.code)));
  assert.ok(run.nodes.includes('saveNote') && run.nodes.includes('db'), JSON.stringify(run.nodes));
});

// The intake rule is sensitive <= sensitiveMax. Thus a candidate with the
// value 0.16 is approved.
test('decider intake: sensitive equal to sensitiveMax 0.16 is approved and gives the writes edge', async t => {
  const run = await intakeRun(t, { sensitive: 0.16 });
  assert.deepEqual(run.edges, [['saveNote', 'writes', 'db']], JSON.stringify(run.decisions.map(row => row.diagnostics.code)));
  assert.ok(run.nodes.includes('saveNote') && run.nodes.includes('db'), JSON.stringify(run.nodes));
  const intake = run.decisions.flatMap(row => row.diagnostics.trace?.intake ?? []);
  assert.ok(intake.length >= 1, JSON.stringify(run.decisions.map(row => row.diagnostics.code)));
  for (const entry of intake) {
    assert.equal(entry.sensitive, 0.16);
    assert.equal(entry.approved, true);
  }
});

test('decider intake: sensitive above the decider sensitiveMax gives no node', async t => {
  const run = await intakeRun(t, { sensitive: DECIDER_INTAKE_POLICY.sensitiveMax + 0.02 });
  assert.deepEqual(run.nodes, []);
  assert.deepEqual(run.edges, []);
  assert.ok(run.decisions.length >= 1);
  for (const row of run.decisions) assert.equal(row.diagnostics.code, 'no_approved_candidates');
});

test('Jev intake keeps sensitiveMax 0.1: sensitive 0.14 gives no node', async t => {
  const run = await intakeRun(t, { provider: 'jev', sensitive: 0.14 });
  assert.deepEqual(run.nodes, []);
  assert.equal(run.current.decisionService.intakePolicyVersion, 'intake-policy-v1');
  assert.ok(run.decisions.length >= 1);
  for (const row of run.decisions) {
    assert.equal(row.diagnostics.code, 'no_approved_candidates');
    assert.equal(row.diagnostics.intakePolicyVersion, 'intake-policy-v1');
    assert.deepEqual(row.diagnostics.trace.thresholds.intake, { sensitiveMax: 0.1, relevantMin: 0.5 });
  }
});

test('decider decision records and their trace show the decider intake policy', async t => {
  const run = await intakeRun(t, { sensitive: DECIDER_INTAKE_POLICY.sensitiveMax - 0.02 });
  assert.equal(DECIDER_INTAKE_POLICY.version, 'intake-policy-v1-decider-experimental');
  assert.equal(run.current.decisionService.intakePolicyVersion, 'intake-policy-v1-decider-experimental');
  assert.ok(run.decisions.length >= 1);
  for (const row of run.decisions) {
    assert.equal(row.diagnostics.provider, 'decider');
    assert.equal(row.diagnostics.intakePolicyVersion, 'intake-policy-v1-decider-experimental');
    assert.deepEqual(row.diagnostics.trace.thresholds.intake,
      { sensitiveMax: DECIDER_INTAKE_POLICY.sensitiveMax, relevantMin: DECIDER_INTAKE_POLICY.relevantMin });
  }
});

// With concurrency 1, the activity target waits behind the event
// classification and the architecture analysis of each changed file. Its
// deadline comes from the provider limits. The hook reply does not wait for it.
test('a decider activity target waits behind 3 changed files and still gets a decision', async t => {
  const setup = await workspace(t);
  const fake = await fakeDeciderServer(t, (entry, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(deciderAnswer(JSON.parse(entry.body))));
    }, 400);
  });
  const files = ['a.js', 'b.js', 'c.js'];
  const write = (name, i, extra) => writeFile(path.join(setup.projectRoot, name),
    `export function run${i}() { return ${i}; }\nexport function ${extra}${i}() { return ${i + 1}; }\n`);
  for (const [i, name] of files.entries()) await write(name, i, 'helper');
  const server = await startServer({ ...setup, mode: 'live', provider: deciderConfig({ endpoint: fake.endpoint }),
    policy: { readSource: true, transmitSource: true, displayEvidence: true, persistEvidence: false } });
  t.after(() => server.close());
  await server.pipeline.whenIdle();
  // One apply_patch call changes the 3 files.
  for (const [i, name] of files.entries()) await write(name, i, 'changed');
  const patch = ['*** Begin Patch', ...files.flatMap(name => [`*** Update File: ${name}`, '@@', '+// changed']),
    '*** End Patch'].join('\n');
  const mapped = () => server.pipeline.getModelState().activity.filter(row => row.kind === 'activity.mapped');
  const result = await server.pipeline.ingest({ cwd: setup.projectRoot, hook_event_name: 'PostToolUse',
    session_id: 'synthetic-targets', tool_name: 'apply_patch', tool_use_id: 'targets-edit',
    tool_input: { input: patch }, tool_response: { success: true } }, { host: 'codex' });
  assert.equal(result.accepted, true);
  assert.equal(mapped().length, 0, 'the hook reply does not wait for the target result');
  await server.pipeline.whenIdle();
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const current = await health(paths);
  const logs = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: current.instanceId });
  const targets = logs.records.filter(row => row.stage === 'classification' && row.eventKind === 'tool.succeeded');
  assert.deepEqual(targets.map(row => [row.status, row.reason]), [['accepted', 'approved']]);
  assert.equal(mapped().length, 1);
  assert.equal(mapped()[0].mapping, 'decision');
  assert.ok(fake.requests.some(entry => Object.keys(JSON.parse(entry.body).questions).includes('target_0')));
});

test('doctor and graphlin provider show the decider limits and the policy versions', async t => {
  const setup = await deciderSetup(t);
  const details = { ...described, limits: { ...DECIDER_LIMITS }, intakePolicy: { ...deciderIntakePolicy },
    admissionPolicyVersion: 'admission-policy-v1-decider-experimental' };
  let result = await cli(setup, ['doctor'], { PATH: setup.base });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).provider, details);
  result = await cli(setup, ['provider']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).provider, details);
  // Jev output does not change.
  result = await cli(setup, ['provider', 'jev']);
  assert.deepEqual(JSON.parse(result.stdout).provider, { id: 'jev' });
  result = await cli(setup, ['doctor'], { PATH: setup.base });
  assert.deepEqual(JSON.parse(result.stdout).provider, { id: 'jev' });
});

test('graphlin provider shows and saves the provider; doctor needs no key and sends no probe', async t => {
  const setup = await workspace(t);
  await saveSettings(setup, { policy: consent });
  let result = await cli(setup, ['provider']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).provider, { id: 'jev' });
  result = await cli(setup, ['provider', 'decider', '--endpoint', 'http://127.0.0.1:9/v1/systemone']);
  assert.equal(result.code, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.deepEqual(shown.provider, { id: 'decider', experimental: true, endpoint: 'http://127.0.0.1:9/v1/systemone',
    model: DEFAULT_DECIDER_MODEL, limits: { ...DECIDER_LIMITS }, intakePolicy: { ...deciderIntakePolicy },
    admissionPolicyVersion: 'admission-policy-v1-decider-experimental' });
  assert.match(shown.note, /Experimental/);
  assert.match(shown.note, /all projects that use this Graphlin data directory/);
  assert.deepEqual((await readSettings(setup)).decisionProvider, { id: 'decider',
    endpoint: 'http://127.0.0.1:9/v1/systemone', model: DEFAULT_DECIDER_MODEL });
  for (const args of [['provider', 'decider', '--endpoint', 'http://localhost:8099/v1/systemone'],
    ['provider', 'decider', '--endpoint', 'http://[::1]:9/v1/systemone'],
    ['provider', 'decider', '--model', 'other-model']]) {
    result = await cli(setup, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid_provider/);
    assert.match(result.stderr, /must start with strands-decider- and have 64 characters or fewer/);
  }
  result = await cli(setup, ['provider', 'jev', '--endpoint', 'http://127.0.0.1:8099/v1/systemone']);
  assert.match(result.stderr, /conflicting_arguments/);
  result = await cli(setup, ['doctor'], { PATH: setup.base });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.credential, 'not_required');
  assert.equal(report.provider.id, 'decider');
  assert.equal(report.provider.experimental, true);
  assert.equal(report.provider.endpoint, 'http://127.0.0.1:9/v1/systemone');
  assert.ok(report.nextActions.some(action => /experimental/.test(action) && /tunnel/.test(action)));
  assert.equal(report.nextActions.some(action => /TypeSafe key/.test(action)), false);
  result = await cli(setup, ['provider', 'jev']);
  assert.deepEqual(JSON.parse(result.stdout).provider, { id: 'jev' });
  assert.equal((await readSettings(setup)).decisionProvider, undefined);
});

test('diagnostics keep the provider ID and a decider model of 64 characters or fewer', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  const logger = await createDiagnostics({ ...paths, policy: { transmitSource: true } });
  t.after(() => logger.close());
  const base = { schemaVersion: 1, at: '2026-01-01T00:00:00.000Z', stage: 'classification', status: 'accepted', reason: 'ok' };
  const request = model => ({ stage: 'A', model, rubricVersion: 'intake-v1', status: 'ok', code: 'ok' });
  logger.record({ ...base, diagnostics: { code: 'ok', mode: 'live', provider: 'decider',
    admissionPolicyVersion: 'admission-policy-v1-decider-experimental', intakePolicyVersion: 'intake-policy-v1',
    trace: { version: 1, requests: [request(DEFAULT_DECIDER_MODEL)] } } });
  logger.record({ ...base, diagnostics: { code: 'ok', provider: 'RAW_PROVIDER',
    admissionPolicyVersion: 'admission-policy-v1-RAW', trace: { version: 1, requests: [
      request(`strands-decider-${'x'.repeat(49)}`), request('RAW_MODEL_SECRET')] } } });
  const [kept, refused] = logger.snapshot().records;
  assert.equal(kept.diagnostics.provider, 'decider');
  assert.equal(kept.diagnostics.admissionPolicyVersion, 'admission-policy-v1-decider-experimental');
  assert.equal(kept.diagnostics.trace.requests[0].model, DEFAULT_DECIDER_MODEL);
  assert.equal(refused.diagnostics.provider, undefined);
  assert.equal(refused.diagnostics.admissionPolicyVersion, undefined);
  assert.deepEqual(refused.diagnostics.trace.requests.map(entry => entry.model), [undefined, undefined]);
  await logger.close();
  const disk = await readPersistedDiagnostics(paths);
  assert.equal(disk.records[0].diagnostics.provider, 'decider');
  assert.doesNotMatch(JSON.stringify(disk), /RAW_/);
});
