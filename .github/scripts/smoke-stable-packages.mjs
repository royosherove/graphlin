import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// No checkout runtime imports: every runtime dependency must resolve from the
// stable bundle after the extracted package and npm installation are gone.
const SOURCE = "export function saveNote() { return 'synthetic note'; }\n";
const RELATIVE_FILE = 'src/one/two/three/four/five/six/notes.mjs';

function runHook(pluginRoot, host, projectRoot, dataDir, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', [path.join(pluginRoot, 'scripts/collect.sh'), host], {
      cwd: projectRoot, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH, GRAPHLIN_NODE: process.execPath, GRAPHLIN_DATA_DIR: dataDir },
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error('Packaged hook did not exit successfully.')); return; }
      try {
        assert.equal(stdout, '', 'Packaged hook must have no stdout.');
        assert.equal(stderr, '', 'Packaged hook must have no stderr.');
        resolve();
      } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => {}); // Fail-open launchers may close stdin early.
    child.stdin.end(JSON.stringify({ cwd: projectRoot, session_id: 'packaged-smoke', ...payload }));
  });
}

export async function smokeStablePackage({ pluginRoot, host, projectRoot, dataDir }) {
  assert.ok(['claude', 'codex'].includes(host));
  const [{ startServer }, { demoDecisionService }, { normalizeHostEvent }] = await Promise.all([
    import(pathToFileURL(path.join(pluginRoot, 'runtime/daemon/server.mjs'))),
    import(pathToFileURL(path.join(pluginRoot, 'runtime/daemon/demo.mjs'))),
    import(pathToFileURL(path.join(pluginRoot, 'runtime/core/privacy.mjs'))),
  ]);
  const filename = path.join(projectRoot, RELATIVE_FILE);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, SOURCE);
  const service = demoDecisionService();
  let server;
  try {
    server = await startServer({ projectRoot, dataDir, mode: 'demo', decisionService: service,
      policy: { transmitSource: true, displayEvidence: true, persistEvidence: false } });
    const launch = new URL(server.url), origin = launch.origin;
    assert.equal(launch.hostname, '127.0.0.1');
    const request = (route, options = {}) => fetch(`${origin}${route}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    const denied = await request('/api/state');
    assert.equal(denied.status, 401, 'The packaged viewer must require authentication.');
    await denied.arrayBuffer();
    const authenticated = await request('/api/auth', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get('token') }),
    });
    assert.equal(authenticated.status, 200, 'The packaged viewer must accept its fresh launch token.');
    await authenticated.arrayBuffer();
    const cookie = authenticated.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Authentication must issue a session cookie.');
    const get = async route => {
      const response = await request(route, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    await server.pipeline.whenIdle();
    const initial = await get('/api/state');
    assert.deepEqual(initial.sessions, []);
    assert.deepEqual(initial.graph.nodes, []);
    assert.equal(service.stats().calls, 0, 'The deep fixture must not be classified by a background scan.');

    await runHook(pluginRoot, host, projectRoot, dataDir, { hook_event_name: 'SessionStart' });
    await server.pipeline.whenIdle();
    const started = await get('/api/state');
    assert.equal(started.sessions.length, 1, `${host} SessionStart must reach the packaged server through IPC.`);
    assert.equal(started.sessionId, normalizeHostEvent({ session_id: 'packaged-smoke' },
      { host, projectId: started.projectId }).event.sessionId, 'The IPC receipt must use the requested host adapter.');
    assert.deepEqual(started.graph.nodes, [], 'A session receipt is not source evidence.');
    assert.equal(service.stats().calls, 0);

    await runHook(pluginRoot, host, projectRoot, dataDir, {
      hook_event_name: 'PostToolUse', tool_use_id: 'read-synthetic-note',
      tool_name: host === 'claude' ? 'Read' : 'read_file',
      tool_input: host === 'claude' ? { file_path: filename } : { path: filename },
      tool_response: { success: true },
    });
    await server.pipeline.whenIdle();
    const state = await get('/api/state');
    assert.equal(state.sessionId, started.sessionId);
    assert.equal(state.graph.nodes.length, 1, `${host} packaged read hook must produce the first source-backed shape.`);
    const [node] = state.graph.nodes;
    assert.equal(node.label, 'saveNote');
    assert.equal(node.kind, 'function');
    assert.equal(node.classification, 'accepted');
    assert.equal(node.evidenceState, 'observed', 'Source evidence must not claim runtime execution.');
    assert.equal(node.sourceRefs.length, 1);
    assert.equal(node.sourceRefs[0].hash, createHash('sha256').update(SOURCE).digest('hex'));
    assert.deepEqual(state.graph.edges, []);
    assert.equal(state.hookEvents.length, 2);
    assert.deepEqual(state.hookEvents.map(event => event.kind), ['session.started', 'tool.succeeded']);
    assert.ok(state.hookEvents.every(event => event.sessionId === state.sessionId));

    const diagnostics = await get('/api/diagnostics');
    const accepted = diagnostics.records.find(record =>
      record.sessionId === state.sessionId && record.stage === 'classification' && record.status === 'accepted');
    assert.ok(accepted, 'The packaged offline classifier must complete its real decision workflow.');
    assert.deepEqual(accepted.diagnostics.trace.requests.map(request => request.stage), ['A', 'B']);
    assert.ok(accepted.diagnostics.trace.requests.every(request => request.dispatched));
    assert.ok(diagnostics.records.some(record => record.stage === 'capture' &&
      record.artifacts.some(artifact => artifact.path === RELATIVE_FILE)));
    assert.equal(service.stats().mode, 'demo');
    assert.equal(service.stats().callsA, 1);
    assert.equal(service.stats().callsB, 1);
    return { host, sourceEvidence: true, hooks: state.hookEvents.length };
  } finally {
    if (server) {
      await server.close();
      assert.deepEqual(await server.whenClosed, { ok: true }, 'The smoke server must shut down completely.');
    } else await service.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // The fixture transport handles all classifier requests. Fail rather than
    // contact an external API if that contract regresses. Only local HTTP
    // authentication/state requests are permitted by this smoke process.
    const localFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Package smoke must stay offline.');
      return localFetch(input, options);
    };
    const [stable, dataDir, projectParent] = process.argv.slice(2);
    const results = [];
    for (const host of ['claude', 'codex']) results.push(await smokeStablePackage({
      pluginRoot: path.join(stable, host, 'graphlin'), host, dataDir,
      projectRoot: path.join(projectParent, host),
    }));
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } catch {
    // Never print launch tokens, cookies, filesystem details, or child output.
    process.stderr.write('Graphlin stable plugin smoke failed.\n');
    process.exitCode = 1;
  }
}
