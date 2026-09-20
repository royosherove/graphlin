import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { createRecordedProvider } from '../decisions/recorded-provider.mjs';

export const architectureSources = Object.freeze({
  'main.js': [
    "import { createServer } from 'node:http';",
    "import { orders } from './orders.js';",
    'export function startApplication() {',
    '  const server = createServer(orders);',
    '  server.listen(8080);',
    '  return server;',
    '}',
  ].join('\n'),
  'orders.js': [
    'export function orders(request, response) {',
    "  response.end('Synthetic order response');",
    '}',
  ].join('\n'),
});

/** Literal answers for generated source, using the real neutral provider contract. */
export function createArchitectureProvider({ transform = value => value } = {}) {
  const roles = new Map([
    [architectureSources['main.js'], 'application'],
    [architectureSources['orders.js'], 'component'],
  ]);
  const gates = new Set();
  let nextGate;
  const provider = createRecordedProvider({ async transform(value, request, call, context) {
    if (nextGate) {
      const gate = nextGate;
      nextGate = null;
      gate.enter(request);
      await gate.wait;
    }
    if (request.questions.kind) {
      const code = request.state.evidence.map(value => value.code).join('\n');
      const kind = roles.get(code) ?? 'unknown';
      value.answers.kind = {
        type: 'choice', choice: kind, confidence: 0.95,
        probabilities: Object.fromEntries(['application', 'component', 'unknown'].map(candidate =>
          [candidate, candidate === kind ? 0.97 : candidate === (kind === 'unknown' ? 'application' : 'unknown') ? 0.03 : 0])),
      };
      value.answers.supported = { type: 'boolean', probability: kind === 'unknown' ? 0.01 : 0.98 };
      value.answers.missing_context = { type: 'boolean', probability: 0.01 };
    }
    for (const id of Object.keys(request.questions)) {
      if (id.startsWith('member_')) value.answers[id] = { type: 'boolean', probability: 0.98 };
      if (id.startsWith('missing_')) value.answers[id] = { type: 'boolean', probability: 0.01 };
    }
    return transform(value, request, call, context);
  } });
  return {
    provider,
    setRole(source, role) {
      assert.ok(['application', 'component', 'unknown'].includes(role));
      roles.set(source, role);
    },
    holdNext() {
      assert.ok(!nextGate, 'only one upcoming provider call may be held');
      let enter, release;
      const started = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      const gate = { enter, wait, release: () => { release(); gates.delete(gate); } };
      gates.add(gate); nextGate = gate;
      return { started, release: gate.release };
    },
    releaseAll() { nextGate = null; for (const gate of gates) gate.release(); },
  };
}

/** A real authenticated daemon over temporary source; no source file is executed. */
export async function createArchitectureFixture({
  policy = { transmitSource: true, displayEvidence: true },
  missingService = false, waitForIdle = true, transform,
} = {}) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-architecture-server-'));
  const projectRoot = path.join(directory, 'project'), dataDir = path.join(directory, 'data');
  const control = createArchitectureProvider({ transform });
  let server, closing;
  const close = () => closing ??= (async () => {
    control.releaseAll();
    try { await server?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  })();
  try {
    await mkdir(projectRoot, { mode: 0o700 });
    await Promise.all(Object.entries(architectureSources).map(([name, content]) =>
      writeFile(path.join(projectRoot, name), content)));
    server = await startServer({
      projectRoot, dataDir, policy,
      ...(missingService ? { decisionService: { stats: () => ({ calls: 0 }), close() {} } }
        : { decisionProvider: control.provider }),
    });
    const launch = new URL(server.url), origin = launch.origin;
    const token = new URLSearchParams(launch.hash.slice(1)).get('token');
    const authenticated = await fetch(origin + '/api/auth', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(2500) });
    assert.equal(authenticated.status, 200);
    await authenticated.text();
    const cookie = authenticated.headers.get('set-cookie').split(';')[0];
    async function request(route, { authenticated = true, method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(origin + route, { method,
        headers: { ...(authenticated ? { Cookie: cookie } : {}),
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(2500) });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, headers: response.headers, data, raw };
    }
    const post = (route, body = {}, options = {}) => request(route, { method: 'POST', body, ...options });
    async function updateSource(name, source, role) {
      assert.ok(Object.hasOwn(architectureSources, name));
      control.setRole(source, role);
      await writeFile(path.join(projectRoot, name), source);
      await server.pipeline.reconcile();
      await server.pipeline.whenIdle();
    }
    async function deleteSource(name) {
      assert.ok(Object.hasOwn(architectureSources, name));
      await rm(path.join(projectRoot, name));
      await server.pipeline.reconcile();
      await server.pipeline.whenIdle();
    }
    if (waitForIdle) await server.pipeline.whenIdle();
    return {
      directory, projectRoot, dataDir, server, pipeline: server.pipeline, origin, cookie,
      provider: control.provider, holdNext: control.holdNext,
      request, post, updateSource, deleteSource, close,
    };
  } catch (error) { await close(); throw error; }
}
