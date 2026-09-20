import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { ARCHITECTURE_NAMESPACE, ARCHITECTURE_VERSION } from '../../runtime/architecture/profile.mjs';
import { architectureSources, createArchitectureFixture } from '../helpers/architecture-fixture.mjs';

const options = { timeout: 12_000 };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const supported = model => model.interpretations.filter(value =>
  value.namespace === ARCHITECTURE_NAMESPACE && value.validity === 'current' &&
  value.support === 'supported' && value.classification === 'accepted');

async function fixture(t, settings) {
  const value = await createArchitectureFixture(settings);
  t.after(value.close);
  return value;
}

function heldAnswer(t, matches = request => request.questions.kind) {
  let armed = false, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  t.after(release);
  return {
    started, release, arm() { armed = true; },
    async transform(value, request, _call, context) {
      if (armed && matches(request)) {
        armed = false;
        entered({ request, context });
        // An uncooperative provider still returns a valid answer after cancellation.
        await wait;
      }
      return value;
    },
  };
}

async function model(f) {
  const result = await f.request('/api/model/v1/snapshot');
  assert.equal(result.status, 200, result.raw);
  assert.equal(result.data.partial, false);
  assert.doesNotMatch(result.raw, /createServer\(|response\.end\(|Synthetic order response/);
  return result.data;
}

function boundaries(snapshot) {
  const roles = supported(snapshot);
  assert.deepEqual(roles.map(value => value.kind).sort(), ['application', 'architecture_membership', 'component']);
  const application = roles.find(value => value.kind === 'application');
  const component = roles.find(value => value.kind === 'component');
  const membership = roles.find(value => value.kind === 'architecture_membership');
  assert.deepEqual(membership.entityIds, [application.entityIds[0], component.entityIds[0]]);
  for (const role of roles) {
    assert.equal(role.version, ARCHITECTURE_VERSION);
    assert.ok(role.sourceRefs.length > 0);
    assert.ok(role.sourceRefs.every(ref => snapshot.coverage.enumerations.some(certificate =>
      certificate.artifactId === ref.artifactId && certificate.hash === ref.hash &&
      certificate.generation === ref.generation && certificate.complete)));
    assert.ok(role.entityIds.every(id => snapshot.entities.some(value =>
      value.id === id && value.kind === 'module' && value.basis === 'parsed' && value.validity === 'current')));
  }
  assert.equal(membership.sourceRefs.length, 2);
  const scene = c4Scene(snapshot, { level: 'applications' });
  const outer = scene.groups.find(value => value.membershipId === application.id);
  const inner = scene.groups.find(value => value.membershipId === component.id);
  assert.ok(outer && inner, 'actual discovered interpretations render application and component groups');
  assert.equal(inner.parentId, outer.id);
  assert.match(scene.coverage.label, /does not establish runtime hosting/);
  return { application, component, membership };
}

test('real daemon automatically discovers source-backed architecture through neutral A/B profiles and C4', options, async t => {
  const f = await fixture(t);
  const snapshot = await model(f);
  assert.equal(snapshot.projectId, sha256(await realpath(f.projectRoot)));
  assert.deepEqual(snapshot.sessions, [], 'automatic discovery needs no host session or tool event');
  assert.equal(snapshot.entities.some(value => value.basis === 'parsed'), true);
  boundaries(snapshot);
  const status = await f.request('/api/architecture');
  assert.equal(status.status, 200, status.raw);
  assert.equal(status.data.status, 'complete');
  assert.equal(status.data.applications, 1);
  assert.equal(status.data.components, 1);
  assert.equal(status.data.pending, 0);
  assert.equal(status.data.failures, 0);
  const requests = f.provider.calls.map(value => value.request);
  assert.equal(requests.filter(value => value.questions.a_activity).length, 2, 'both files pass privacy intake');
  const roleRequests = requests.filter(value => value.questions.kind);
  assert.equal(roleRequests.length, 2, 'the server registers the built-in source role profile');
  assert.deepEqual(roleRequests.map(value => value.state.evidence.map(entry => entry.code).join('\n')).sort(),
    Object.values(architectureSources).sort());
  const membership = requests.filter(value => value.questions.member_0);
  assert.equal(membership.length, 1);
  assert.doesNotMatch(JSON.stringify(membership[0].state), /createServer|response\.end|sourceRefs|relativePath|generation/);
  assert.equal(requests.length, 5, 'two A/B source workflows and one finite metadata evaluation');
});

test('incremental edit advances supported source versions and deletion withdraws component membership', options, async t => {
  const f = await fixture(t);
  const initial = boundaries(await model(f));
  const changed = architectureSources['orders.js'].replace('Synthetic order response', 'Updated synthetic response');
  await f.updateSource('orders.js', changed, 'component');
  const updated = boundaries(await model(f));
  assert.equal(updated.component.id, initial.component.id);
  assert.equal(updated.membership.id, initial.membership.id);
  assert.equal(updated.component.sourceRefs[0].hash, sha256(changed));
  assert.ok(updated.component.sourceRefs[0].generation > initial.component.sourceRefs[0].generation);
  assert.deepEqual(updated.application.sourceRefs, initial.application.sourceRefs);
  assert.ok(updated.membership.sourceRefs.some(ref => ref.hash === sha256(changed)));
  const callsAfterEdit = f.provider.calls.length;
  assert.ok(callsAfterEdit > 5 && callsAfterEdit <= 10, 'a small source edit stays within one bounded analysis pass');
  await f.pipeline.reconcile();
  await f.pipeline.whenIdle();
  assert.equal(f.provider.calls.length, callsAfterEdit, 'unchanged reconciliation does not repeat completed analysis');

  await f.deleteSource('orders.js');
  const deleted = await model(f), remaining = supported(deleted);
  assert.deepEqual(remaining.map(value => value.kind), ['application']);
  assert.ok(deleted.entities.filter(value => value.artifactId === initial.component.sourceRefs[0].artifactId)
    .every(value => value.validity !== 'current'));
  const status = await f.request('/api/architecture');
  assert.equal(status.data.applications, 1);
  assert.equal(status.data.components, 0);
  const scene = c4Scene(deleted, { level: 'applications' });
  assert.equal(scene.groups.some(value => value.membershipId === initial.component.id), false);
});

test('manual discovery returns 202 before a held provider and needs viewer auth but no extension grant', options, async t => {
  const f = await fixture(t);
  const installed = await f.request('/api/extensions');
  assert.equal(installed.status, 200);
  assert.deepEqual(installed.data, []);
  assert.equal((await f.request('/api/architecture', { authenticated: false })).status, 401);
  assert.equal((await f.post('/api/architecture/discover', {}, { authenticated: false })).status, 401);
  assert.equal((await f.post('/api/architecture/discover', {}, { headers: { Origin: 'https://hostile.example' } })).status, 403);
  assert.equal((await f.request('/api/architecture', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.request('/api/architecture?token=synthetic')).status, 400);
  assert.equal((await f.post('/api/architecture/discover', { extensionId: 'unapproved' })).status, 400);
  assert.equal((await f.post('/api/architecture/discover', '[]')).status, 400);
  const gate = f.holdNext();
  const response = await f.post('/api/architecture/discover');
  assert.equal(response.status, 202, response.raw);
  assert.ok(['queued', 'running'].includes(response.data.status));
  const drained = f.pipeline.whenIdle();
  try {
    await gate.started;
    const running = await f.request('/api/architecture');
    assert.equal(running.status, 200);
    assert.equal(running.data.status, 'running');
  } finally { gate.release(); await drained; }
  assert.equal((await f.request('/api/architecture')).data.status, 'complete');
  boundaries(await model(f));
});

test('pausing rejects a held source answer and resuming discovers fresh supported architecture', options, async t => {
  const gate = heldAnswer(t);
  gate.arm();
  const f = await fixture(t, { waitForIdle: false, transform: gate.transform });
  const drained = f.pipeline.whenIdle();
  const held = await gate.started;
  assert.deepEqual(supported(await model(f)), []);
  f.pipeline.setPaused(true);
  assert.equal(held.context.signal.aborted, true);
  gate.release();
  await drained;
  const status = await f.request('/api/architecture');
  assert.equal(status.data.status, 'unavailable');
  assert.equal(status.data.reason, 'paused');
  assert.deepEqual(supported(await model(f)), [], 'a valid late answer cannot establish boundaries while paused');
  const calls = f.provider.calls.length;
  f.pipeline.setPaused(false);
  await f.pipeline.whenIdle();
  boundaries(await model(f));
  assert.ok(f.provider.calls.length > calls, 'resume obtains new answers');
});

test('a held old-lineage answer cannot overwrite same-byte recapture or a frozen checkpoint', options, async t => {
  const gate = heldAnswer(t);
  const f = await fixture(t, { transform: gate.transform });
  const initial = boundaries(await model(f));
  const marker = f.pipeline.createCheckpoint({ label: 'Before synthetic branch switch' });
  const frozen = f.pipeline.getModelState({ checkpointId: marker.id });
  gate.arm();
  assert.equal((await f.post('/api/architecture/discover')).status, 202);
  const drained = f.pipeline.whenIdle();
  const held = await gate.started;
  const lineage = { id: sha256('synthetic-architecture-next-branch'),
    status: 'git', branch: 'feature/synthetic-next', head: 'b'.repeat(40) };
  await f.pipeline.observeLineage(lineage);
  assert.equal(held.context.signal.aborted, true);
  assert.deepEqual(supported(f.pipeline.getModelState()), [], 'branch changes immediately invalidate old support');
  await f.pipeline.reconcile();
  await drained;
  await f.pipeline.whenIdle();
  const current = await model(f), fresh = boundaries(current);
  assert.deepEqual(current.coverage.lineage, lineage);
  for (const kind of ['application', 'component']) {
    assert.equal(fresh[kind].sourceRefs[0].hash, initial[kind].sourceRefs[0].hash);
    assert.ok(fresh[kind].sourceRefs[0].generation > initial[kind].sourceRefs[0].generation);
  }
  gate.release();
  await tick();
  await f.pipeline.whenIdle();
  assert.deepEqual(supported(await model(f)), supported(current));
  assert.deepEqual(f.pipeline.getModelState({ checkpointId: marker.id }), frozen);
});

test('commit rereads source edited on disk while an answer is held without a reconciliation request', options, async t => {
  const gate = heldAnswer(t, request => request.questions.kind &&
    request.state.evidence.some(value => value.code === architectureSources['orders.js']));
  const f = await fixture(t, { transform: gate.transform });
  const initial = boundaries(await model(f));
  gate.arm();
  assert.equal((await f.post('/api/architecture/discover')).status, 202);
  const drained = f.pipeline.whenIdle();
  await gate.started;
  const changed = 'export const retiredOrders = true;\n';
  await writeFile(path.join(f.projectRoot, 'orders.js'), changed);
  gate.release();
  await drained;
  const snapshot = await model(f);
  const certificate = snapshot.coverage.enumerations.find(value =>
    value.artifactId === initial.component.sourceRefs[0].artifactId);
  assert.equal(certificate.hash, sha256(changed));
  assert.ok(certificate.generation > initial.component.sourceRefs[0].generation);
  assert.equal(certificate.complete, true);
  assert.deepEqual(supported(snapshot).map(value => value.kind), ['application'],
    'the old supported component and membership cannot survive the changed source');
  assert.ok(f.provider.calls.some(({ request }) => request.questions.kind &&
    request.state.evidence.some(value => value.code === changed)), 'commit revalidation triggers fresh analysis');
});

test('a pending deletion clear cannot erase a source recreated before commit without reconciliation', options, async t => {
  const gate = heldAnswer(t, request => request.questions.kind &&
    request.state.evidence.some(value => value.code === architectureSources['main.js']));
  const f = await fixture(t, { transform: gate.transform });
  const initial = boundaries(await model(f));
  const file = path.join(f.projectRoot, 'orders.js');
  gate.arm();
  await rm(file);
  await f.pipeline.reconcile();
  // Select both the deleted file and live application, whose held answer
  // keeps the batch's old absence observation pending until after recreation.
  assert.equal((await f.post('/api/architecture/discover')).status, 202);
  const drained = f.pipeline.whenIdle();
  await gate.started;
  const missing = f.pipeline.getModelState().coverage.artifacts.find(value =>
    value.id === initial.component.sourceRefs[0].artifactId);
  assert.equal(missing.status, 'missing');
  await writeFile(file, architectureSources['orders.js']);
  gate.release();
  await drained;
  const current = boundaries(await model(f));
  assert.equal(current.component.id, initial.component.id);
  assert.equal(current.membership.id, initial.membership.id);
  assert.equal(current.component.sourceRefs[0].hash, initial.component.sourceRefs[0].hash);
  assert.ok(current.component.sourceRefs[0].generation > missing.generation);
  assert.ok(current.membership.sourceRefs.some(ref =>
    ref.artifactId === missing.id && ref.generation === current.component.sourceRefs[0].generation));
  assert.equal((await f.request('/api/architecture')).data.pending, 0);
});

test('model capacity reports partial discovery without evicting unrelated interpretations or retrying', options, async t => {
  const f = await fixture(t);
  const { application } = boundaries(await model(f));
  const store = f.pipeline.model;
  assert.equal(store.replaceInterpretations(ARCHITECTURE_NAMESPACE, []).accepted, true);
  store.observeInterpretations(Array.from({ length: 510 }, (_, index) => ({
    ...application, id: `retained-${index}`, namespace: 'example.capacity',
    kind: 'responsibility', label: `Retained ${index}`,
  })));
  assert.equal(store.replaceInterpretations(ARCHITECTURE_NAMESPACE, [
    { ...application, id: 'previous-application' },
  ]).accepted, true);
  assert.equal(store.stats().interpretations, 511);
  const unrelated = snapshot => snapshot.interpretations.filter(value => value.namespace === 'example.capacity');
  const retained = unrelated(f.pipeline.getModelState());
  assert.equal(retained.length, 510);
  const calls = f.provider.calls.length;
  assert.equal((await f.post('/api/architecture/discover')).status, 202);
  await f.pipeline.whenIdle();
  const status = await f.request('/api/architecture');
  assert.equal(status.status, 200, status.raw);
  assert.equal(status.data.status, 'partial');
  assert.ok(status.data.omitted > 0, 'successful admission must report results lost to model capacity');
  assert.equal(status.data.pending, 0);
  const snapshot = f.pipeline.getModelState();
  assert.equal(snapshot.interpretations.length, 512);
  assert.equal(supported(snapshot).length, 2, 'only two of the three discovery results fit');
  assert.deepEqual(unrelated(snapshot), retained);
  assert.equal(f.provider.calls.length - calls, 5, 'capacity exhaustion completes one bounded analysis pass');
  await f.pipeline.reconcile();
  await f.pipeline.whenIdle();
  assert.equal(f.provider.calls.length - calls, 5, 'unchanged source cannot trigger a capacity retry loop');
  assert.equal((await f.request('/api/architecture')).data.status, 'partial');
});

for (const [name, settings, parsed] of [
  ['local-only source consent', { policy: { readSource: true, transmitSource: false } }, true],
  ['metadata-only consent', { policy: { readSource: false, transmitSource: false } }, false],
  ['missing architecture service', { missingService: true }, true],
]) {
  test(`${name} never calls a provider or invents supported architecture`, options, async t => {
    const f = await fixture(t, settings);
    const snapshot = await model(f);
    assert.equal(snapshot.entities.some(value => value.basis === 'parsed'), parsed);
    assert.deepEqual(supported(snapshot), []);
    const status = await f.request('/api/architecture');
    assert.equal(status.status, 200, status.raw);
    assert.equal(status.data.status, 'unavailable');
    assert.equal(typeof status.data.reason, 'string');
    assert.equal(status.data.applications, 0);
    assert.equal(status.data.components, 0);
    const manual = await f.post('/api/architecture/discover');
    assert.equal(manual.status, 202, manual.raw);
    await f.pipeline.whenIdle();
    assert.equal(f.provider.calls.length, 0);
    assert.deepEqual(supported(await model(f)), []);
  });
}
