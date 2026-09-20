import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { health } from '../../runtime/daemon/lock.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';
import { createDemoProject, demoDecisionService, replayDemo } from '../../runtime/daemon/demo.mjs';
import { collect } from '../../runtime/collector/index.mjs';
import { workspace, authenticate } from './helpers.mjs';

const noRemote = () => ({ classify: async () => { throw new Error('unexpected_remote'); }, stats: () => ({ calls: 0 }), close() {} });

test('the sketch module is served as JavaScript without browser authentication', async t => {
  const setup = await workspace(t);
  const asset = new URL('../../runtime/web/sketch.js', import.meta.url);
  const source = 'export const sketchFixture = true;\n';
  const originalRead = fs.readFile;
  // The drawing worker owns sketch.js. Exercise this route independently of
  // whether that worker has published its implementation yet.
  t.mock.method(fs, 'readFile', (filename, ...args) =>
    filename instanceof URL && filename.href === asset.href
      ? Promise.resolve(Buffer.from(source)) : originalRead(filename, ...args));
  syncBuiltinESMExports();
  let server;
  try {
    server = await startServer({ ...setup, decisionService: noRemote() });
    const origin = new URL(server.url).origin;
    const response = await fetch(`${origin}/sketch.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(await response.text(), source);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${origin}/sketch.js`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally {
    await server?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('HTTP auth, origin/host guards, controls, SSE resync, and private IPC are enforced', async t => {
  const setup = await workspace(t);
  const server = await startServer({ ...setup, decisionService: noRemote() });
  t.after(() => server.close());
  const { origin, cookie, token } = await authenticate(server);
  const get = (route, headers = {}) => fetch(origin + route, { headers: { Cookie: cookie, ...headers } });
  assert.equal((await fetch(origin + '/api/state')).status, 401);
  assert.equal((await fetch(origin + '/api/connection-info')).status, 401);
  assert.equal((await get('/api/connection-info', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/api/state', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/api/state?token=' + token)).status, 400);
  const wrongHost = await new Promise(resolve => {
    http.get(origin + '/api/state', { headers: { Host: 'evil.example', Cookie: cookie } },
      response => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(wrongHost, 403);
  const reuse = await fetch(origin + '/api/auth', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(reuse.status, 401);
  const csrf = await fetch(origin + '/api/control', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"action":"pause"}' });
  assert.equal(csrf.status, 403);
  assert.equal((await fetch(origin + '/api/control', { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{"action":"pause"}' })).status, 200);
  assert.equal((await (await get('/api/state')).json()).paused, true);
  assert.equal((await get('/api/state')).headers.get('access-control-allow-origin'), null);
  assert.match((await get('/')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const layout = await get('/layout.js');
  assert.equal(layout.status, 200);
  assert.match(layout.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await layout.text(), await readFile(new URL('../../runtime/web/layout.js', import.meta.url), 'utf8'));
  assert.equal((await get('/layout.js', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/layout.js.map')).status, 404);
  const sidebar = await get('/sidebar.js');
  assert.equal(sidebar.status, 200);
  assert.match(sidebar.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await sidebar.text(), await readFile(new URL('../../runtime/web/sidebar.js', import.meta.url), 'utf8'));
  assert.equal((await get('/sidebar.js', { Origin: 'https://evil.example' })).status, 403);

  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const info = await health(paths);
  assert.equal(info.port, server.port);
  assert.equal((await stat(paths.socket)).mode & 0o777, 0o600);
  assert.equal((await requestIPC(paths.socket, { op: 'shutdown', instanceId: 'wrong' })).ok, false);
  await assert.rejects(startServer({ ...setup, decisionService: noRemote() }), { code: 'already_running' });
  assert.equal(await collect({ cwd: setup.projectRoot, hook_event_name: 'SessionStart', session_id: 'one' },
    { dataDir: setup.dataDir }), true);
  const controller = new AbortController();
  const response = await fetch(origin + '/api/events', { headers: { Cookie: cookie, 'Last-Event-ID': 'outdated' },
    signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  const state = JSON.parse(first.split('data: ')[1].trim());
  assert.equal(state.activity[0].label, 'Session started');
  controller.abort(); await reader.cancel().catch(() => {});
  const exported = await get('/api/export');
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal((await exported.json()).projectId, state.projectId);
});

test('metadata-only intake never persists raw prompts, tool inputs, credentials, or launch credentials', async t => {
  const setup = await workspace(t);
  let called = 0;
  const server = await startServer({ ...setup, decisionService: {
    classify() { called++; throw new Error('unexpected'); }, stats: () => ({ calls: called }), close() {},
  } });
  const { origin, cookie, token } = await authenticate(server);
  await collect({ cwd: setup.projectRoot, hook_event_name: 'UserPromptSubmit', session_id: 'private-session',
    prompt: 'DO_NOT_PERSIST_PROMPT_991 API_KEY=do-not-transmit-this-secret' }, { dataDir: setup.dataDir });
  await collect({ cwd: setup.projectRoot, hook_event_name: 'PostToolUse', session_id: 'private-session',
    tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'DO_NOT_PERSIST_COMMAND_991' },
    tool_response: { stdout: 'DO_NOT_PERSIST_BODY_991' } }, { dataDir: setup.dataDir });
  const viewer = await (await fetch(origin + '/api/state', { headers: { Cookie: cookie } })).text();
  await server.close();
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const disk = await readFile(paths.state, 'utf8');
  for (const sentinel of ['DO_NOT_PERSIST_', 'do-not-transmit-this-secret', token, cookie.split('=')[1]]) {
    assert.equal(viewer.includes(sentinel), false);
    assert.equal(disk.includes(sentinel), false);
  }
  assert.equal(called, 0);
  assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
  const reopened = await startServer({ ...setup, decisionService: noRemote() });
  t.after(() => reopened.close());
  assert.ok(reopened.pipeline.getState().activity.length >= 1);
});

test('missing-key startup is reported without a request even before the first candidate', async t => {
  const setup = await workspace(t);
  const original = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let server;
  try { server = await startServer({ ...setup, policy: { transmitSource: true } }); }
  finally {
    if (original === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = original;
  }
  t.after(() => server.close());
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  assert.equal((await health(paths)).status.classifier, 'missing_key');
});

test('offline demo injects the fixture transport into the real two-stage pipeline', async t => {
  const { dataDir } = await workspace(t);
  const projectRoot = await createDemoProject(dataDir), service = demoDecisionService();
  const server = await startServer({ projectRoot, dataDir, policy: { transmitSource: true },
    mode: 'demo', decisionService: service });
  t.after(() => server.close());
  const snapshot = await replayDemo(server.pipeline, projectRoot);
  assert.equal(snapshot.mode, 'demo');
  assert.ok(snapshot.graph.nodes.length >= 2, JSON.stringify(snapshot.status));
  assert.ok(snapshot.graph.edges.some(edge => edge.relation === 'writes'));
  assert.ok(snapshot.status.calls >= 2);
  assert.equal(service.stats().mode, 'demo');
  const before = snapshot.graph;
  // Reconciliation must run without classification being available.
  server.pipeline.setPaused(true);
  await writeFile(path.join(projectRoot, 'notes.mjs'), '// removed write fixture\n');
  await server.pipeline.reconcile();
  const after = server.pipeline.getState().graph;
  assert.ok(after.revision > before.revision);
});
