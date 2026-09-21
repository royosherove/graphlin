import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateModel, VIEW_MODEL_LIMITS } from '../../runtime/web/model-client.js';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { validateScene } from '../../runtime/extensions/scene.mjs';
import { PREFIX, entity, fixture, cursorQuery } from '../helpers/model-api-fixture.mjs';

const architecture = (id, kind, anchors, changes = {}) => ({
  id, kind, namespace: 'graphlin.architecture', label: id,
  entityIds: anchors.map(value => value.id),
  sourceRefs: anchors.flatMap(value => value.sourceRefs),
  basis: 'decision', validity: 'current', classification: 'accepted', support: 'supported',
  ...changes,
});
const directory = (id, parentId = null) => ({
  ...entity(id, parentId), kind: 'directory', basis: 'metadata', sourceRefs: [],
});
const ids = values => values.map(value => value.id);

test('tail architecture survives bounded hydration with complete ancestors and genuine C4 nesting', async t => {
  const f = await fixture(t);
  const root = directory('root'), services = directory('z.services', root.id), source = directory('z.source', services.id);
  const application = { ...entity('z.application', source.id), artifactId: 'artifact.application',
    sourceRefs: [{ artifactId: 'artifact.application', hash: 'a'.repeat(64), generation: 1 }] };
  const component = { ...entity('z.component', source.id), artifactId: 'artifact.component',
    sourceRefs: [{ artifactId: 'artifact.component', hash: 'b'.repeat(64), generation: 1 }] };
  const method = { ...entity('z.method', component.id), kind: 'function', sourceRefs: component.sourceRefs };
  const unrelated = Array.from({ length: 5674 }, (_, index) => entity(`a.${String(index).padStart(4, '0')}`, root.id));
  f.state.entities = [root, ...unrelated, services, source, application, component, method];
  f.state.interpretations = [
    ...Array.from({ length: 509 }, (_, index) => architecture(`a.legacy.${String(index).padStart(3, '0')}`,
      'module', [unrelated[0]], { namespace: 'graphlin.legacy-role' })),
    architecture('z.arch.application', 'application', [application]),
    architecture('z.arch.component', 'component', [component]),
    architecture('z.arch.membership', 'architecture_membership', [application, component]),
  ];
  f.state.relations = [{ id: 'imports', source: application.id, target: component.id,
    kind: 'imports', basis: 'parsed', validity: 'current',
    sourceRefs: [...application.sourceRefs, ...component.sourceRefs] }];
  f.state.activity = [];
  const before = structuredClone(f.state);
  assert.equal(f.state.entities.length, 5680);
  assert.ok(f.state.entities.indexOf(application) > VIEW_MODEL_LIMITS.entities);
  const initial = await f.request('snapshot');
  assert.equal(initial.status, 200, initial.raw);
  assert.ok(Buffer.byteLength(initial.raw) <= 512 * 1024);
  const priority = [root.id, services.id, source.id, application.id, component.id];
  const expected = [...priority, ...ids(unrelated), method.id];
  assert.deepEqual(ids(initial.data.entities), expected.slice(0, initial.data.entities.length));
  assert.deepEqual(ids(initial.data.interpretations).slice(0, 3),
    ['z.arch.application', 'z.arch.component', 'z.arch.membership']);
  const requests = [];
  const hydrated = await hydrateModel(initial.data, { request: async route => {
    const response = await f.request(route.slice(PREFIX.length));
    assert.equal(response.status, 200, response.raw);
    assert.ok(Buffer.byteLength(response.raw) <= 512 * 1024);
    requests.push(route);
    return response.data;
  } });
  assert.equal(VIEW_MODEL_LIMITS.entities, 2048);
  assert.deepEqual(ids(hydrated.entities), expected.slice(0, 2048));
  assert.equal(hydrated.coverage.client.totals.entities, 5680);
  assert.equal(hydrated.coverage.client.retained.entities, 2048);
  assert.equal(hydrated.coverage.client.truncated, true);
  assert.equal(new Set(ids(hydrated.entities)).size, 2048);
  const seen = new Set();
  for (const value of hydrated.entities) {
    if (value.parentId) assert.ok(seen.has(value.parentId), value.id);
    seen.add(value.id);
  }
  assert.ok(requests.some(route => route.startsWith(PREFIX + 'entities?')));
  assert.deepEqual(hydrated.relations, f.state.relations);
  for (const projection of [initial.data, hydrated]) {
    const scene = validateScene(c4Scene(projection, { level: 'components' }), { model: projection });
    const parent = scene.groups.find(group => group.id === 'c4.z.arch.application');
    const child = scene.groups.find(group => group.id === 'c4.z.arch.component');
    assert.ok(parent && child);
    assert.equal(child.parentId, parent.id);
    assert.deepEqual(child.entityIds, [component.id]);
  }
  assert.deepEqual(f.state, before, 'ordering never mutates canonical records or provider input');
});

test('only supported source-backed architecture with current canonical anchors changes the old order', async t => {
  const f = await fixture(t);
  const legacy = f.state.interpretations[0], anchor = f.state.entities.find(value => value.id === 'child');
  const boundary = architecture('z.architecture', 'application', [anchor]);
  const original = ['root', 'alpha', 'beta', 'child'];
  const invalid = [
    { namespace: 'example.architecture' }, { kind: 'datastore' },
    { validity: 'stale' }, { validity: 'retracted' },
    { support: 'unknown' }, { classification: 'tentative' },
    { sourceRefs: [] }, { sourceRefs: [{ eventId: 'event-one' }] },
    { sourceRefs: [{ artifactId: 'artifact-one' }] },
    { entityIds: [] }, { entityIds: ['missing'] }, { entityIds: ['child', 'missing'] },
  ];
  for (const changes of invalid) {
    f.state.interpretations = [legacy, { ...boundary, ...changes }];
    const response = await f.request('snapshot');
    assert.equal(response.status, 200, response.raw);
    assert.deepEqual(ids(response.data.entities), original, JSON.stringify(changes));
    assert.deepEqual(ids(response.data.interpretations), [legacy.id, boundary.id]);
  }
  f.state.interpretations = [legacy, boundary];
  for (const validity of ['stale', 'retracted']) {
    anchor.validity = validity;
    const response = await f.request('snapshot');
    assert.deepEqual(ids(response.data.entities), original);
    assert.deepEqual(ids(response.data.interpretations), [legacy.id, boundary.id]);
  }
  anchor.validity = 'current';
  const prioritized = await f.request('snapshot');
  assert.deepEqual(ids(prioritized.data.entities), ['root', 'alpha', 'child', 'beta']);
  assert.deepEqual(ids(prioritized.data.interpretations), [boundary.id, legacy.id]);
  f.state.interpretations = [legacy];
  assert.deepEqual(ids((await f.request('snapshot')).data.entities), original);
});

test('architecture ordering uses only the caller-visible scope and granted fields', async t => {
  const f = await fixture(t);
  const child = f.state.entities.find(value => value.id === 'child');
  const beta = f.state.entities.find(value => value.id === 'beta');
  const inside = architecture('z.inside', 'component', [child]);
  const outside = architecture('z.outside', 'application', [beta]);
  const membership = architecture('z.membership', 'architecture_membership', [beta, child]);
  f.state.interpretations = [outside, membership, inside];
  const scoped = await f.request('snapshot?scope=alpha&session=session-one');
  assert.equal(scoped.status, 200);
  assert.deepEqual(ids(scoped.data.entities), ['root', 'alpha', 'child']);
  assert.deepEqual(ids(scoped.data.interpretations), [inside.id]);
  assert.deepEqual(ids(scoped.data.activity), ['event-one']);
  assert.deepEqual(ids(scoped.data.relations), ['relation-one']);
  const grant = await f.grant({ fields: ['entities'], history: false });
  const options = { viewer: false, headers: grant.headers };
  const first = await f.request('entities?limit=1', options);
  inside.support = 'unknown';
  const continuation = await f.request(`entities?cursor=${cursorQuery(first.data.page.nextCursor)}`, options);
  assert.equal(continuation.status, 200, 'withheld interpretation changes cannot alter ordering or fingerprints');
  assert.deepEqual([...ids(first.data.items), ...ids(continuation.data.items)], ['root', 'alpha', 'beta', 'child']);
  const restricted = await f.request('snapshot', options);
  assert.deepEqual(restricted.data.interpretations, []);
  assert.deepEqual(restricted.data.relations, []);
  assert.deepEqual(restricted.data.activity, []);
  assert.equal((await f.request('snapshot?session=session-one', options)).status, 403);
  const interpretations = await f.grant({ fields: ['interpretations'], history: false });
  const noAnchors = await f.request('snapshot', { viewer: false, headers: interpretations.headers });
  assert.deepEqual(noAnchors.data.entities, []);
  assert.deepEqual(ids(noAnchors.data.interpretations), ['z.inside', 'z.membership', 'z.outside']);
});

test('snapshot continuations share deterministic architecture order and reject changed support at the same revision', async t => {
  const f = await fixture(t);
  const child = f.state.entities.find(value => value.id === 'child');
  const boundary = architecture('z.architecture', 'application', [child]);
  f.state.interpretations.push(boundary);
  const first = await f.request('snapshot?limit=5');
  const initialIds = ids(first.data.entities);
  assert.deepEqual(initialIds, ['root']);
  f.state.entities.reverse();
  f.state.interpretations.reverse();
  const cursor = first.data.pages.entities.nextCursor;
  const next = await f.request(`entities?cursor=${cursorQuery(cursor)}`);
  assert.equal(next.status, 200, next.raw);
  assert.deepEqual([...initialIds, ...ids(next.data.items)], ['root', 'alpha', 'child', 'beta']);
  assert.deepEqual(next.data.transport, first.data.transport);
  assert.deepEqual(next.data.selection, first.data.selection);
  const children = await f.request('entities/root/children');
  assert.deepEqual(ids(children.data.items), ['alpha', 'beta']);
  const version = { revision: f.state.revision, sequence: f.state.sequence };
  boundary.support = 'unknown';
  assert.equal((await f.request(`entities?cursor=${cursorQuery(cursor)}`)).status, 409);
  const fresh = await f.request('snapshot');
  assert.deepEqual(ids(fresh.data.entities), ['root', 'alpha', 'beta', 'child']);
  assert.equal(fresh.data.revision, version.revision);
  assert.equal(fresh.data.sequence, version.sequence);
});
