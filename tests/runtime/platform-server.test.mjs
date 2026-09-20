import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { createExtensionRegistry, validateScene, validateMessage } from '../../runtime/extensions/index.mjs';

const MODEL = '/api/model/v1/';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const localPolicy = { readSource: true, transmitSource: false, displayEvidence: true, persistEvidence: true };
const source = name => `// SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT\nexport class ${name} {\n  handle(request) { return request; }\n}\n`;

async function setup(t) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-platform-server-'));
  const projectRoot = path.join(directory, 'project'), dataDir = path.join(directory, 'data');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(projectRoot, 'src/gateway.js'), source('SyntheticGateway'));
  await writeFile(path.join(projectRoot, 'src/store.js'), 'export function readSession(id) { return { id }; }\n');
  const calls = { classify: 0, evaluate: 0 }, servers = new Set();
  const service = () => ({
    async classify() { calls.classify++; throw new Error('unexpected_synthetic_classification'); },
    async evaluate() { calls.evaluate++; throw new Error('unexpected_synthetic_evaluation'); },
    stats: () => ({ calls: calls.classify + calls.evaluate, mode: 'synthetic' }),
    close() {},
  });
  t.after(async () => {
    try { for (const server of servers) await server.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  async function start(policy = localPolicy) {
    const server = await startServer({ projectRoot, dataDir, policy, decisionService: service() });
    servers.add(server);
    await server.pipeline.whenIdle();
    const launch = new URL(server.url), origin = launch.origin;
    const token = new URLSearchParams(launch.hash.slice(1)).get('token');
    const auth = await fetch(origin + '/api/auth', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    async function request(route, { authenticated = true, method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(origin + route, { method,
        headers: { ...(authenticated ? { Cookie: cookie } : {}),
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000) });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, headers: response.headers, data, raw };
    }
    const post = (route, body, options = {}) => request(route, { method: 'POST', body, ...options });
    async function stream(headers = {}) {
      const controller = new AbortController();
      const response = await fetch(origin + MODEL + 'events', {
        headers: { Cookie: cookie, ...headers }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      const stop = async () => { controller.abort(); await reader.cancel().catch(() => {}); };
      t.after(stop);
      async function next() {
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          while (!buffer.includes('\n\n')) {
            const chunk = await reader.read();
            if (chunk.done) return null;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          const boundary = buffer.indexOf('\n\n'), frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          return { type: /^event: (.+)$/m.exec(frame)?.[1],
            id: /^id: (.+)$/m.exec(frame)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]) };
        } finally { clearTimeout(timeout); }
      }
      return { next, stop };
    }
    return { server, origin, cookie, token, request, post, stream, pipeline: server.pipeline,
      close: async () => { await server.close(); servers.delete(server); } };
  }
  return { directory, projectRoot, dataDir, start, calls,
    paths: () => projectPaths(projectRoot, dataDir) };
}

test('real daemon discovers parsed source without a session or Jev and serves authenticated model/view contracts', async t => {
  const f = await setup(t), host = await f.start();
  const expectedProject = sha256(await realpath(f.projectRoot));
  const snapshot = await host.request(MODEL + 'snapshot');
  assert.equal(snapshot.status, 200, snapshot.raw);
  assert.equal(snapshot.data.projectId, expectedProject);
  assert.match(snapshot.data.projectId, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.data.sessions, []);
  const gateway = snapshot.data.entities.find(value => value.label === 'SyntheticGateway' && value.basis === 'parsed');
  assert.ok(gateway);
  assert.ok(snapshot.data.entities.some(value => value.id === gateway.parentId && value.kind === 'module'));
  assert.ok(snapshot.data.entities.some(value => value.parentId === gateway.id && value.label === 'handle'));
  assert.ok(snapshot.data.coverage.enumerations.some(value => value.complete && value.capability === 'parsed'));
  assert.equal(snapshot.data.coverage.parsing.queued, 0);
  assert.ok(snapshot.data.coverage.parsing.parsed >= 2);
  assert.equal(snapshot.data.storage, undefined);
  assert.doesNotMatch(snapshot.raw, /SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT/);
  for (const route of ['snapshot', 'bootstrap', 'capabilities', 'history', 'entities']) {
    assert.equal((await host.request(MODEL + route, { authenticated: false })).status, 401);
  }
  for (const asset of ['/platform.js', '/model-client.js', '/scene.js', '/extension-frame.js',
    '/visualizers/index.mjs', '/visualizers/c4.mjs', '/visualizers/changes.mjs',
    '/extensions/sdk.mjs', '/extensions/contracts.mjs', '/extensions/scene.mjs', '/extensions/profiles.mjs']) {
    const response = await host.request(asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(response.raw, /SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT/);
  }
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});

test('real model query routing retains authentication, exact Host checks and client-local scope', async t => {
  const f = await setup(t), host = await f.start();
  const snapshot = (await host.request(MODEL + 'snapshot')).data;
  const module = snapshot.entities.find(value => value.kind === 'module' && value.label === 'gateway.js');
  assert.ok(module);
  const before = host.pipeline.getState().selectedSession;
  const scoped = await host.request(MODEL + `snapshot?scope=${module.id}`);
  assert.equal(scoped.status, 200);
  assert.ok(scoped.data.entities.some(value => value.id === module.id));
  assert.ok(scoped.data.entities.some(value => value.kind === 'project'));
  assert.equal(host.pipeline.getState().selectedSession, before);
  for (const suffix of ['?token=synthetic', '?scope=one&scope=two', '?limit=201', '?scope=%2Fprivate']) {
    assert.equal((await host.request(MODEL + 'snapshot' + suffix)).status, 400);
  }
  assert.equal((await host.request(MODEL + 'snapshot?scope=' + module.id, { authenticated: false })).status, 401);
  assert.equal((await host.request('/api/state?scope=' + module.id)).status, 400);
  for (const origin of ['https://unpaired.example', 'null']) {
    const denied = await host.request(MODEL + 'snapshot', { headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } });
    assert.ok([401, 403].includes(denied.status));
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  const status = await new Promise((resolve, reject) => {
    http.get(host.origin + MODEL + 'snapshot', { headers: { Host: 'untrusted.example', Cookie: host.cookie } },
      response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});

test('real checkpoint, SSE, restart and current policy preserve frozen history without replay inference', async t => {
  const f = await setup(t), first = await f.start();
  const initial = (await first.request(MODEL + 'snapshot')).data;
  const events = await first.stream(), initialEvent = await events.next();
  assert.equal(initialEvent.type, 'snapshot');
  const created = await first.post(MODEL + 'checkpoints', { label: 'Synthetic source baseline' });
  assert.equal(created.status, 201, created.raw);
  const marker = created.data.checkpoint;
  assert.equal(marker.projectId, initial.projectId);
  const changed = await events.next();
  assert.equal(changed.type, 'snapshot');
  assert.ok(changed.data.checkpoints.some(value => value.id === marker.id));
  assert.ok(changed.data.transport.sequence > initialEvent.data.transport.sequence);
  await events.stop();
  await writeFile(path.join(f.projectRoot, 'src/gateway.js'), source('SyntheticGatewayUpdated'));
  await first.pipeline.reconcile(); await first.pipeline.whenIdle();
  const live = (await first.request(MODEL + 'snapshot')).data;
  assert.ok(live.entities.some(value => value.label === 'SyntheticGatewayUpdated' && value.validity === 'current'));
  const history = (await first.request(MODEL + `snapshot?checkpoint=${marker.id}`)).data;
  assert.equal(history.revision, marker.revision);
  assert.equal(history.sequence, marker.sequence);
  assert.ok(history.entities.some(value => value.label === 'SyntheticGateway'));
  assert.equal(history.entities.some(value => value.label === 'SyntheticGatewayUpdated'), false);
  await first.close();
  const paths = await f.paths(), modelFile = path.join(paths.directory, 'model-state.json');
  const saved = JSON.parse(await readFile(modelFile, 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.projectId, initial.projectId);
  assert.ok(saved.snapshot.checkpoints.some(value => value.id === marker.id && value.state));
  assert.equal((await stat(modelFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(paths.state, 'utf8')).schemaVersion, 1);

  const restarted = await f.start({ readSource: false, transmitSource: false, displayEvidence: false, persistEvidence: false });
  for (const selector of ['', `?checkpoint=${marker.id}`]) {
    const response = await restarted.request(MODEL + 'snapshot' + selector);
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.data.projectId, initial.projectId);
    assert.doesNotMatch(response.raw, /SyntheticGateway|Synthetic source baseline|SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT/);
    assert.equal(response.data.storage, undefined);
  }
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});

test('actual server allows paired browser bearer/preflight while rejecting cross-origin cookies and external mutations', async t => {
  const f = await setup(t), host = await f.start();
  const snapshot = (await host.request(MODEL + 'snapshot')).data, origin = 'https://paired.example';
  const granted = await host.post(MODEL + 'grants', { projectId: snapshot.projectId,
    fields: ['entities', 'activity', 'coverage'], history: false, origins: [origin], ttlSeconds: 60 });
  assert.equal(granted.status, 201, granted.raw);
  const token = granted.data.token, bearer = { Authorization: `Bearer ${token}` };
  const preflight = await host.request(MODEL + 'snapshot?scope=' + snapshot.entities[0].id,
    { authenticated: false, method: 'OPTIONS', headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site',
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization, Last-Event-ID' } });
  assert.equal(preflight.status, 204, preflight.raw);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const read = await host.request(MODEL + 'snapshot', { authenticated: false,
    headers: { ...bearer, Origin: origin, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(read.status, 200, read.raw);
  assert.equal(read.data.projectId, snapshot.projectId);
  assert.equal(read.headers.get('access-control-allow-origin'), origin);
  assert.doesNotMatch(read.raw, /SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT/);
  assert.equal((await host.request(MODEL + 'snapshot', { authenticated: false, headers: bearer })).status, 200);
  const cookieOnly = await host.request(MODEL + 'snapshot', { headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cookieOnly.status, 401);
  for (const badOrigin of ['null', 'https://unpaired.example']) {
    assert.equal((await host.request(MODEL + 'snapshot', { authenticated: false,
      headers: { ...bearer, Origin: badOrigin } })).status, 403);
  }
  for (const route of ['checkpoints', 'grants', 'grants/revoke']) {
    assert.equal((await host.post(MODEL + route, {}, { authenticated: false, headers: bearer })).status, 403);
  }
  for (const route of ['/api/state', '/api/extensions']) {
    assert.equal((await host.request(route, { authenticated: false, headers: bearer })).status, 401);
  }
  assert.equal((await host.request(MODEL + 'history', { authenticated: false, headers: bearer })).status, 403);
  const stream = await host.stream({ Cookie: '', ...bearer, Origin: origin, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal((await stream.next()).type, 'snapshot');
  assert.equal((await host.post(MODEL + 'grants/revoke', { grantId: granted.data.grant.id })).status, 200);
  assert.equal((await stream.next()).type, 'revoked');
  assert.equal(await stream.next(), null);
  assert.equal((await host.request(MODEL + 'snapshot', { authenticated: false, headers: bearer })).status, 401);
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});

test('actual server expires an idle external stream without capture or client activity', async t => {
  const f = await setup(t), host = await f.start();
  const { projectId } = (await host.request(MODEL + 'snapshot')).data;
  const granted = await host.post(MODEL + 'grants', { projectId, fields: ['entities'], history: false, ttlSeconds: 1 });
  assert.equal(granted.status, 201);
  const events = await host.stream({ Cookie: '', Authorization: `Bearer ${granted.data.token}` });
  assert.equal((await events.next()).type, 'snapshot');
  let event;
  do { event = await events.next(); } while (event?.type === 'snapshot');
  assert.equal(event?.type, 'expired');
  assert.equal(await events.next(), null);
});

// A tiny deterministic fixture bundler for the four public SDK modules. It
// copies no daemon code, fetches no dependencies, and executes no build scripts.
// The authored input imports the public graphlin/extensions/sdk package path.
async function bundledExample() {
  const modules = [];
  for (const name of ['contracts.mjs', 'scene.mjs', 'profiles.mjs', 'sdk.mjs']) {
    let code = await readFile(new URL(`../../runtime/extensions/${name}`, import.meta.url), 'utf8');
    const exported = [], reexports = [];
    const bindings = input => input.split(',').map(value => value.trim()).filter(Boolean)
      .map(value => value.replace(/\s+as\s+/, ': ')).join(', ');
    code = code.replace(/export\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"];?/g, (_all, names, from) => {
      for (const key of names.split(',').map(value => value.trim()).filter(Boolean)) {
        reexports.push(`${key}: modules[${JSON.stringify(from)}].${key}`);
      }
      return '';
    });
    code = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"];?/g,
      (_all, names, from) => `const { ${bindings(names)} } = modules[${JSON.stringify(from)}];`);
    code = code.replace(/\bexport\s+(const|function)\s+([A-Za-z_$][\w$]*)/g,
      (_all, declaration, name) => { exported.push(name); return `${declaration} ${name}`; });
    code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    modules.push(`modules[${JSON.stringify(name)}] = (() => {\n${code}\nreturn {${[...exported, ...reexports].join(',')}};\n})();`);
  }
  const authored = `import { connectExtension } from 'graphlin/extensions/sdk';
connectExtension({ project(model) {
  const root = model.entities.find(entity => entity.parentId === null) || model.entities[0];
  const modules = model.entities.filter(entity => entity.kind === 'module' && entity.basis === 'parsed').slice(0, 20);
  return { sceneVersion: 1,
    groups: root ? [{ id: 'system', entityIds: [root.id], label: 'Synthetic source components', parentId: null }] : [],
    nodes: modules.map(entity => ({ id: 'component-' + entity.id, entityId: entity.id,
      label: entity.label, kind: 'module', parentId: 'system' })),
    edges: [], coverage: { shown: modules.length, total: model.entities.length,
      truncated: modules.length < model.entities.length, label: 'Source components; runtime boundaries unknown' } };
} });`;
  const executable = authored.replace(/^import[^;]+;\n/, '');
  return { authored, bundle: `(() => { const modules = {};\n${modules.join('\n')}\nconst { connectExtension } = modules["sdk.mjs"];\n${executable}\n})();` };
}

async function installExample(f, { hostile = false } = {}) {
  const authorDirectory = path.join(f.directory, hostile ? 'hostile-author' : 'independent-author');
  const packageDirectory = path.join(authorDirectory, 'package');
  await mkdir(path.join(packageDirectory, 'dist'), { recursive: true, mode: 0o700 });
  const example = await bundledExample();
  const hostileSource = `window.addEventListener("graphlin:connect", () => {
    const text = "</script><img src=x onerror=alert(1)>";
    window.parent.postMessage({type:"synthetic-hostile",text}, "*");
    fetch("/api/control", {method:"POST",body:"{}"});
  });`;
  const bundle = hostile ? hostileSource : example.bundle;
  await writeFile(path.join(authorDirectory, 'author.mjs'), example.authored);
  const manifest = { manifestVersion: 1, id: hostile ? 'example.hostile' : 'example.platform-c4',
    name: hostile ? 'Synthetic hostile fixture' : 'Synthetic SDK C4', version: '1.0.0',
    graphlinApi: '1', modelSchema: '2', requiredFeatures: ['containment', 'canonical-mappings', 'scene-groups'],
    entry: 'dist/visualizer.js', views: ['components'], renderer: { kind: 'graphlin-scene', sceneVersion: '1' },
    capabilities: ['model.read', 'history.read'],
    assets: { 'dist/visualizer.js': `sha256-${sha256(bundle)}` } };
  await writeFile(path.join(packageDirectory, 'graphlin.extension.json'), JSON.stringify(manifest));
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: hostile ? 'synthetic-hostile' : 'synthetic-sdk-c4', version: '1.0.0',
    scripts: { install: 'node -e "process.exit(99)"', prepack: 'node -e "process.exit(99)"' },
  }));
  await writeFile(path.join(packageDirectory, 'dist/visualizer.js'), bundle);
  const { projectId } = await f.paths();
  const registry = await createExtensionRegistry({ dataDir: f.dataDir, projectId });
  const installed = await registry.install(packageDirectory);
  return { registry, installed, bundle, authorDirectory };
}

function approve(host, installed, changes = {}) {
  return host.post('/api/extensions/grant', { id: installed.id, digest: installed.digest,
    fields: ['entities', 'relations', 'coverage'], history: true, approved: true, ...changes });
}

test('independently authored public-SDK C4 installs, requires approval, consumes actual daemon data and survives source removal', async t => {
  const f = await setup(t), host = await f.start(), example = await installExample(f);
  const { installed } = example, dataRoute = `/api/extensions/data/${installed.id}`;
  const frameRoute = `/api/extensions/frame/${installed.id}?nonce=${'n'.repeat(32)}`;
  assert.equal(installed.grant, null);
  const listed = await host.request('/api/extensions');
  assert.equal(listed.status, 200);
  assert.equal(listed.data[0].id, installed.id);
  assert.equal(listed.data[0].grant, null);
  assert.equal((await host.request(dataRoute)).status, 403);
  assert.equal((await host.request(frameRoute)).status, 403);
  assert.equal((await approve(host, installed, { approved: false })).status, 200);
  assert.equal((await host.request(dataRoute)).status, 403);
  assert.equal((await approve(host, installed, { digest: 'f'.repeat(64) })).status, 409);
  assert.equal((await approve(host, installed)).status, 200);
  const delivered = await host.request(dataRoute);
  assert.equal(delivered.status, 200, delivered.raw);
  assert.equal(delivered.data.projectId, sha256(await realpath(f.projectRoot)));
  assert.doesNotMatch(delivered.raw, /SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT/);
  assert.equal(delivered.data.storage, undefined);
  assert.ok(delivered.data.entities.some(value => value.label === 'SyntheticGateway'));

  // Execute only our trusted synthetic bundle to test the public SDK lifecycle.
  // This VM is a test harness, not the production extension security boundary.
  const listeners = new Map(), messages = [];
  const port = { start() {}, close() {}, postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) };
  const context = vm.createContext({
    TextEncoder, window: { addEventListener: (type, callback) => listeners.set(type, callback),
      removeEventListener: type => listeners.delete(type) },
    document: { getElementById: () => ({}) }, port,
  });
  vm.runInContext(example.bundle, context, { timeout: 1000 });
  listeners.get('graphlin:connect')({ detail: { port, assets: {} } });
  const message = { type: 'graphlin:project', apiVersion: 1, instanceId: 'synthetic-frame',
    projectId: delivered.data.projectId, revision: delivered.data.revision, viewEpoch: 1,
    requestId: 'synthetic-projection', model: delivered.data, settings: {}, selection: null };
  context.input = JSON.stringify(message);
  await vm.runInContext('port.onmessage({data: JSON.parse(input)})', context, { timeout: 1000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'graphlin:scene', JSON.stringify(messages));
  validateMessage(messages[0], { context: message, model: delivered.data });
  const scene = validateScene(messages[0].scene, { model: delivered.data });
  assert.ok(scene.nodes.length >= 2);
  assert.match(scene.coverage.label, /runtime boundaries unknown/);
  assert.ok(scene.nodes.every(node => delivered.data.entities.some(entity => entity.id === node.entityId)));
  await rm(example.authorDirectory, { recursive: true, force: true });
  assert.equal((await host.request(frameRoute)).status, 200);
  assert.equal((await host.request(dataRoute)).status, 200);
  const checkpoint = await host.post(MODEL + 'checkpoints', { label: 'SDK baseline' });
  assert.equal((await host.request(dataRoute + `?checkpoint=${checkpoint.data.checkpoint.id}`)).status, 200);
  assert.equal((await host.post('/api/extensions/revoke', { id: installed.id })).status, 200);
  assert.equal((await host.request(dataRoute)).status, 403);
  assert.equal((await host.request(frameRoute)).status, 403);
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});

test('hostile installed frame retains response-level sandbox on direct HTTP navigation and cannot authenticate as a host', async t => {
  const f = await setup(t), host = await f.start(), example = await installExample(f, { hostile: true });
  const { installed } = example, route = `/api/extensions/frame/${installed.id}?nonce=${'h'.repeat(32)}`;
  assert.equal((await approve(host, installed)).status, 200);
  assert.equal((await host.request(route, { authenticated: false })).status, 401);
  const direct = await host.request(route);
  assert.equal(direct.status, 200, direct.raw);
  assert.match(direct.headers.get('content-type'), /^text\/html/);
  const csp = direct.headers.get('content-security-policy');
  assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/);
  for (const kind of ['default', 'connect', 'img', 'worker', 'frame']) assert.match(csp, new RegExp(`${kind}-src 'none'`));
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-forms|allow-popups|unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(direct.headers.get('x-frame-options'), null);
  assert.equal(direct.headers.get('set-cookie'), null);
  assert.equal(direct.headers.get('cache-control'), 'no-store');
  assert.equal((direct.raw.match(/<\/script>/g) ?? []).length, 1);
  assert.ok(direct.raw.includes('\\u003c/script>\\u003cimg'));
  assert.ok(direct.raw.includes('parentWindow === window'));
  for (const value of [host.cookie, host.token, 'SYNTHETIC_SOURCE_BODY_DO_NOT_EXPORT']) assert.equal(direct.raw.includes(value), false);
  const model = (await host.request(MODEL + 'snapshot')).data;
  const external = await host.post(MODEL + 'grants', { projectId: model.projectId, fields: ['entities'], history: false });
  assert.equal((await host.request(route, { authenticated: false,
    headers: { Authorization: `Bearer ${external.data.token}` } })).status, 401);
  for (const origin of ['null', 'https://hostile.example']) {
    assert.equal((await host.request(route, { headers: { Origin: origin } })).status, 403);
    assert.equal((await host.post('/api/control', { action: 'pause' }, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await host.request('/api/extensions')).headers.get('x-frame-options'), 'DENY');
  assert.equal((await host.request(`/api/extensions/frame/${installed.id}?nonce=short`)).status, 400);
  assert.equal((await host.request(`/api/extensions/frame/${installed.id}/dist/visualizer.js`)).status, 404);
  assert.deepEqual(f.calls, { classify: 0, evaluate: 0 });
});
