import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createExtensionAPI } from '../../runtime/daemon/extension-api.mjs';
import { createExtensionRegistry } from '../../runtime/extensions/index.mjs';
import { localPackage, model, PROJECT, profile } from '../extensions/fixtures.mjs';

async function setup(t, { analysis, snapshot, registryTransform } = {}) {
  const fixture = await localPackage(t, {
    extra: { 'profiles/c4.json': Buffer.from(JSON.stringify(profile)) },
    manifest: { decisionProfiles: ['profiles/c4.json'],
      capabilities: ['model.read', 'activity.read', 'history.read', 'analysis.request'] },
  });
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const installed = await registry.install(fixture.directory);
  const selections = [], analysisCalls = [];
  let current = model();
  current.entities[0].excerpt = 'PRIVATE_HTTP_CANARY';
  current.entities[1].sourceRefs[0].source = 'PRIVATE_HTTP_CANARY';
  const api = createExtensionAPI({
    registry: registryTransform ? registryTransform(registry) : registry, projectId: PROJECT,
    getSnapshot: options => { selections.push(options); return snapshot ? snapshot(options) : current; },
    ...(analysis ? { runAnalysis: async input => {
      analysisCalls.push(input);
      return analysis(input, { registry, installed, current });
    } } : {}),
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // Synthetic stand-in for the parent's existing cookie + Origin/Host guard.
    // An external bearer must never satisfy viewerAuthorized.
    const viewerAuthorized = req.headers.cookie === 'viewer=synthetic' &&
      (!req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === 'null') &&
      (req.method !== 'POST' || req.headers.origin === `http://${req.headers.host}`);
    if (!await api.handle(req, res, { viewerAuthorized })) { res.writeHead(418); res.end('parent route'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function get(route, headers = {}) {
    return fetch(origin + route, { headers: { Cookie: 'viewer=synthetic', ...headers } });
  }
  function post(route, body, headers = {}) {
    return fetch(origin + route, { method: 'POST', headers: {
      Cookie: 'viewer=synthetic', Origin: origin, 'Content-Type': 'application/json', ...headers,
    }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  }
  function grant(changes = {}) {
    return registry.grant(installed.id, {
      digest: installed.digest, fields: ['entities', 'relations', 'interpretations', 'coverage'],
      history: false, approved: true, ...changes,
    });
  }
  return { registry, installed, origin, get, post, grant, selections, analysisCalls, current };
}

test('extension routes require viewer authorization, reject opaque/external principals and leave parent routes alone', async t => {
  const f = await setup(t);
  assert.equal((await fetch(f.origin + '/api/extensions')).status, 401);
  assert.equal((await fetch(f.origin + '/api/extensions', { headers: { Authorization: 'Bearer synthetic-external' } })).status, 401);
  assert.equal((await f.get('/api/extensions', { Origin: 'null' })).status, 401);
  assert.equal((await f.get('/api/extensions', { Origin: 'https://example.invalid' })).status, 401);
  assert.equal((await f.get('/api/state')).status, 418);
  assert.equal((await f.get('/api/extensions-other')).status, 418);
  const response = await f.get('/api/extensions');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const [row] = await response.json();
  assert.equal(row.id, f.installed.id);
  assert.deepEqual(row.profiles, [{ ...profile, namespace: `${f.installed.id}.${profile.id}` }]);
  assert.equal(row.grant, null);
  assert.equal(Object.hasOwn(row, 'assets'), false);
  assert.equal((await f.get(`/api/extensions/data/${f.installed.id}`)).status, 403);
  assert.equal((await f.get(`/api/extensions/frame/${f.installed.id}?nonce=${'n'.repeat(32)}`)).status, 403);
  assert.equal(f.selections.length, 0);
});

test('grant/revoke endpoints validate body and digest, with no implicit approval', async t => {
  const f = await setup(t);
  const grant = { id: f.installed.id, digest: f.installed.digest, fields: ['entities'], history: false, approved: true };
  assert.equal((await f.post('/api/extensions/grant', grant, { Origin: '' })).status, 401);
  assert.equal((await f.post('/api/extensions/grant', '{bad')).status, 400);
  assert.equal((await f.post('/api/extensions/grant', grant, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/extensions/grant', { ...grant, source: true })).status, 400);
  assert.equal((await f.post('/api/extensions/grant', { ...grant, digest: 'a'.repeat(64) })).status, 409);
  assert.equal((await f.post('/api/extensions/grant', { ...grant, fields: ['source'] })).status, 400);
  assert.equal((await f.post('/api/extensions/grant', { ...grant, approved: false })).status, 200);
  assert.equal(await f.registry.getGrant(grant.id), null);
  assert.equal((await f.post('/api/extensions/grant', grant)).status, 200);
  assert.equal((await f.get(`/api/extensions/data/${grant.id}`)).status, 200);
  assert.equal((await f.post('/api/extensions/revoke', { id: grant.id })).status, 200);
  assert.equal((await f.get(`/api/extensions/data/${grant.id}`)).status, 403);
  assert.equal((await f.post('/api/extensions/grant', '{"padding":"' + 'x'.repeat(17 * 1024) + '"}')).status, 413);
});

test('data has strict scope/session/checkpoint parameters and reapplies the grant to historical snapshots', async t => {
  const f = await setup(t);
  await f.grant();
  const route = `/api/extensions/data/${f.installed.id}`;
  for (const suffix of [
    '?source=1', '?scope=one&scope=two', '?scope=', '?scope=%2Fprivate',
    '?session=%00', '?checkpoint=../private', '?token=synthetic', '?nonce=anything', '?scope=%ZZ',
  ]) assert.equal((await f.get(route + suffix)).status, 400, suffix);
  for (const suffix of ['?checkpoint=checkpoint-1', '?session=session-1']) {
    assert.equal((await f.get(route + suffix)).status, 403);
  }
  const scoped = await f.get(route + '?scope=gateway');
  assert.equal(scoped.status, 200);
  assert.deepEqual(f.selections.at(-1), { scopeId: 'gateway', persistent: false });
  assert.doesNotMatch(await scoped.text(), /PRIVATE_HTTP_CANARY/);
  await f.grant({ history: true, fields: ['entities', 'relations', 'interpretations', 'checkpoints'] });
  const historical = await f.get(route + '?scope=gateway&session=session-1&checkpoint=checkpoint-1');
  assert.equal(historical.status, 200);
  const projected = await historical.json();
  assert.equal(projected.checkpoints[0].id, 'checkpoint-1');
  assert.deepEqual(f.selections.at(-1), {
    scopeId: 'gateway', sessionId: 'session-1', checkpointId: 'checkpoint-1', persistent: false,
  });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_HTTP_CANARY|excerpt/);
});

test('frame applies response sandbox/CSP, strips DENY only for a valid frame and never exposes credentials or model', async t => {
  const f = await setup(t);
  await f.grant();
  const route = `/api/extensions/frame/${f.installed.id}`;
  for (const suffix of ['', '?nonce=short', `?nonce=${'n'.repeat(32)}&asset=../catalogue.json`,
    `?nonce=${'n'.repeat(32)}&nonce=${'x'.repeat(32)}`]) {
    const response = await f.get(route + suffix);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
  const response = await f.get(route + `?nonce=${'n'.repeat(32)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.doesNotMatch(await response.text(), /PRIVATE_HTTP_CANARY|viewer=synthetic/);
  assert.equal((await f.get('/api/extensions')).headers.get('x-frame-options'), 'DENY');
  assert.equal((await f.get(route + '/dist/visualizer.js')).status, 404);
});

test('frame delivery rechecks grants after asset reads and discards revoked output', async t => {
  const f = await setup(t, { registryTransform: registry => ({
    ...registry,
    getAssets: async (...args) => {
      const result = await registry.getAssets(...args);
      await registry.revoke('example.c4');
      return result;
    },
  }) });
  await f.grant();
  const response = await f.get(`/api/extensions/frame/${f.installed.id}?nonce=${'n'.repeat(32)}`);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(await response.text(), /<script>/);
});

test('analysis only invokes the broker for granted declared profiles/current candidates and returns safe recorded IDs', async t => {
  const f = await setup(t, {
    analysis: async (_input, { current }) => {
      current.interpretations.push({ ...current.interpretations[0], id: 'other-profile', namespace: 'other.profile' });
      return { status: 'complete', requestId: 'request-1', interpretationIds: ['architecture', 'other-profile', 'missing'],
        source: 'PRIVATE_ANALYSIS_CANARY', answers: { secret: 'PRIVATE_ANALYSIS_CANARY' } };
    },
  });
  const input = { id: f.installed.id, digest: f.installed.digest, profileId: 'architecture', entityIds: ['gateway'], revision: 7 };
  await f.grant();
  assert.equal((await f.post('/api/extensions/analysis', input)).status, 403);
  await f.grant({ profiles: ['architecture'] });
  for (const [patch, status] of [
    [{ entityIds: ['ungranted'] }, 403], [{ entityIds: ['store'] }, 403],
    [{ profileId: 'unknown' }, 403], [{ revision: 6 }, 409], [{ source: 'private' }, 400],
    [{ digest: 'a'.repeat(64) }, 409], [{ entityIds: [] }, 400],
  ]) assert.equal((await f.post('/api/extensions/analysis', { ...input, ...patch })).status, status);
  assert.equal(f.analysisCalls.length, 0);
  const response = await f.post('/api/extensions/analysis', input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'complete', requestId: 'request-1', interpretationIds: ['architecture'] });
  assert.equal(f.analysisCalls.length, 1);
  const called = f.analysisCalls[0];
  assert.equal(called.profile.namespace, 'example.c4.architecture');
  assert.equal(called.projectId, PROJECT);
  assert.equal(called.signal instanceof AbortSignal, true);
  assert.doesNotMatch(JSON.stringify(called), /PRIVATE_HTTP_CANARY|excerpt/);
});

test('analysis reports unavailable without a broker and rechecks revocation after an asynchronous broker call', async t => {
  const f = await setup(t);
  await f.grant({ profiles: ['architecture'] });
  const input = { id: f.installed.id, digest: f.installed.digest, profileId: 'architecture', entityIds: ['gateway'], revision: 7 };
  assert.equal((await f.post('/api/extensions/analysis', input)).status, 501);
  const revoked = await setup(t, {
    analysis: async (_input, { registry }) => {
      await registry.revoke('example.c4');
      return { status: 'complete', interpretationIds: ['architecture'] };
    },
  });
  await revoked.grant({ profiles: ['architecture'] });
  const response = await revoked.post('/api/extensions/analysis', { ...input, digest: revoked.installed.digest });
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /interpretationIds/);
});

test('invalid snapshots and callback errors fail closed without returning exception details', async t => {
  const f = await setup(t, { snapshot: () => ({ ...model(), projectId: 'another-project' }) });
  await f.grant();
  assert.equal((await f.get(`/api/extensions/data/${f.installed.id}`)).status, 503);
  const broken = await setup(t, { analysis: async () => {
    throw Object.assign(new Error('PRIVATE_EXCEPTION_CANARY'), { status: 200, code: 'PRIVATE_EXCEPTION_CANARY' });
  } });
  await broken.grant({ profiles: ['architecture'] });
  const response = await broken.post('/api/extensions/analysis', {
    id: broken.installed.id, digest: broken.installed.digest, profileId: 'architecture', entityIds: ['gateway'], revision: 7,
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE_EXCEPTION_CANARY/);
});
