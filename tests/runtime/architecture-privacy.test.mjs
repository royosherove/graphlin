import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { privateText } from '../../runtime/core/privacy.mjs';
import { createArchitectureProvider } from '../helpers/architecture-fixture.mjs';

const options = { timeout: 15_000 };
const safeSource = [
  "import { createServer } from 'node:http';",
  'const options = { secret: process.env.SESSION_SECRET };',
  'export function startApplication() {',
  '  const server = createServer(() => {});',
  '  server.listen(8080);',
  '  return server;',
  '}',
].join('\n');
const privateSource = safeSource.replace('process.env.SESSION_SECRET',
  "process.env.SESSION_SECRET || 'SYNTHETIC_FALLBACK_CREDENTIAL'");
const supported = model => model.interpretations.filter(value =>
  value.namespace === 'graphlin.architecture' && value.validity === 'current'
  && value.support === 'supported' && value.classification === 'accepted');

async function fixture(t, files, transform) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-architecture-privacy-'));
  const projectRoot = path.join(directory, 'project'), dataDir = path.join(directory, 'data');
  const control = createArchitectureProvider({ transform });
  control.setRole(safeSource, 'application');
  let server;
  t.after(async () => {
    control.releaseAll();
    try { await server?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(projectRoot, { mode: 0o700 });
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(projectRoot, name), content)));
  server = await startServer({ projectRoot, dataDir, policy: { transmitSource: true },
    decisionProvider: control.provider });
  const launch = new URL(server.url), origin = launch.origin;
  const token = new URLSearchParams(launch.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/auth', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.equal(auth.status, 200);
  await auth.text();
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  async function request(route, method = 'GET') {
    const response = await fetch(origin + route, {
      method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(2500),
    });
    assert.equal(response.status, method === 'POST' ? 202 : 200);
    return response.json();
  }
  await server.pipeline.whenIdle();
  return { server, projectRoot, provider: control.provider, request };
}

test('real daemon reports withheld source and unsupported metadata without provider requests or private logs', options, async t => {
  assert.equal(privateText(privateSource), true);
  assert.equal(privateText(safeSource), false);
  const f = await fixture(t, {
    'server.js': privateSource, 'package.json': '{"name":"synthetic"}',
    'package-lock.json': '{"lockfileVersion":3}', '.gitignore': 'node_modules/',
    'hello.db': Buffer.from([0, 1, 2, 3]),
  });
  // Named metadata may be known through hooks even when it is outside the
  // background parser's language list. It still needs an honest disposition.
  for (const name of ['package-lock.json', '.gitignore', 'hello.db']) {
    await f.server.pipeline.ingest({
      hook_event_name: 'PreToolUse', session_id: 'synthetic-privacy', tool_use_id: name,
      tool_name: 'Read', tool_input: { file_path: name }, cwd: f.projectRoot,
    });
  }
  await f.server.pipeline.whenIdle();
  let state = await f.request('/api/architecture');
  assert.equal(state.status, 'partial');
  assert.equal(state.reason, 'source_withheld');
  assert.equal(state.inspected, 5);
  assert.equal(state.attempted, 5);
  assert.equal(state.analyzed, 0);
  assert.equal(state.withheld, 1);
  assert.equal(state.unsupported, 4);
  assert.equal(state.unavailable, 0);
  assert.equal(state.failures, 0);
  assert.equal(f.provider.calls.length, 0);
  assert.deepEqual(supported(f.server.pipeline.getModelState()), []);
  const diagnostics = await f.request('/api/diagnostics');
  assert.ok(diagnostics.records.some(value => value.diagnostics?.architecture?.withheld === 1));
  assert.ok(diagnostics.records.some(value => value.artifacts?.some(item => item.reason === 'source_withheld')));
  const logPath = diagnostics.logPath;
  // Public records and persisted diagnostics contain metadata only.
  assert.doesNotMatch(JSON.stringify([state, diagnostics, f.server.pipeline.getModelState()]),
    /SYNTHETIC_FALLBACK_CREDENTIAL|SESSION_SECRET|createServer\(/);
  assert.ok(logPath);
  await f.request('/api/architecture/discover', 'POST');
  await f.server.pipeline.whenIdle();
  state = await f.request('/api/architecture');
  assert.equal(state.reason, 'source_withheld', 'manual retry remains enabled for an external edit');
  assert.equal(state.withheld, 1);
  assert.equal(f.provider.calls.length, 0);
  await f.server.close();
  assert.doesNotMatch(await readFile(logPath, 'utf8'), /SYNTHETIC_FALLBACK_CREDENTIAL|SESSION_SECRET/);
});

test('private edit invalidates a supported boundary and safe env-only edit recovers by manual recapture', options, async t => {
  const f = await fixture(t, { 'server.js': safeSource });
  assert.equal((await f.request('/api/architecture')).status, 'complete');
  const [initial] = supported(f.server.pipeline.getModelState());
  assert.equal(initial?.kind, 'application');
  const marker = f.server.pipeline.createCheckpoint({ label: 'Before synthetic private edit' });
  const frozen = f.server.pipeline.getModelState({ checkpointId: marker.id });
  const calls = f.provider.calls.length;
  assert.ok(calls > 0);
  await writeFile(path.join(f.projectRoot, 'server.js'), privateSource);
  await f.server.pipeline.reconcile();
  await f.server.pipeline.whenIdle();
  const privateModel = f.server.pipeline.getModelState();
  assert.deepEqual(supported(privateModel), []);
  assert.equal(privateModel.interpretations.find(value => value.id === initial.id)?.validity, 'stale');
  const withheld = await f.request('/api/architecture');
  assert.equal(withheld.reason, 'source_withheld');
  assert.equal(withheld.withheld, 1);
  assert.equal(withheld.analyzed, 0);
  assert.equal(f.provider.calls.length, calls, 'withheld text never reaches the provider');
  assert.deepEqual(f.server.pipeline.getModelState({ checkpointId: marker.id }), frozen);

  await writeFile(path.join(f.projectRoot, 'server.js'), safeSource);
  await f.request('/api/architecture/discover', 'POST');
  await f.server.pipeline.whenIdle();
  const recovered = await f.request('/api/architecture');
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.applications, 1);
  assert.equal(recovered.analyzed, 1);
  assert.equal(recovered.withheld, 0);
  const [fresh] = supported(f.server.pipeline.getModelState());
  assert.ok(fresh.sourceRefs[0].generation > initial.sourceRefs[0].generation);
  assert.deepEqual(f.server.pipeline.getModelState({ checkpointId: marker.id }), frozen);
  assert.doesNotMatch(JSON.stringify(f.provider.calls.map(value => value.request)), /SYNTHETIC_FALLBACK_CREDENTIAL/);
  assert.doesNotMatch(JSON.stringify(await f.request('/api/diagnostics')), /SYNTHETIC_FALLBACK_CREDENTIAL|SESSION_SECRET/);
});

test('real provider failure remains visible alongside privacy withholding and never logs exception bodies', options, async t => {
  const f = await fixture(t, { 'private.js': privateSource, 'server.js': safeSource }, () => {
    throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR');
  });
  const state = await f.request('/api/architecture');
  assert.equal(state.reason, 'analysis_failed');
  assert.equal(state.withheld, 1);
  assert.equal(state.unavailable, 1);
  assert.equal(state.analyzed, 0);
  assert.ok(state.failures > 0);
  assert.ok(f.provider.calls.length > 0);
  const diagnostics = await f.request('/api/diagnostics');
  assert.ok(diagnostics.records.some(value => value.reason === 'analysis_failed'));
  assert.doesNotMatch(JSON.stringify(diagnostics),
    /SYNTHETIC_FALLBACK_CREDENTIAL|SYNTHETIC_PRIVATE_PROVIDER_ERROR|SESSION_SECRET/);
  assert.doesNotMatch(JSON.stringify(f.provider.calls.map(value => value.request)), /SYNTHETIC_FALLBACK_CREDENTIAL/);
});
