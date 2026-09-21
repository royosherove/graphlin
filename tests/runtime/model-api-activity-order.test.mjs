import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, entity, cursorQuery } from '../helpers/model-api-fixture.mjs';
import { hydrateModel } from '../../runtime/web/model-client.js';

const ids = values => values.map(value => value.id);
const activity = (id, sequence, changes = {}) => ({
  id, sequence, knownAtSequence: sequence, at: '2026-01-01T00:00:00.000Z',
  sessionId: 'session-one', agentId: 'agent-one', toolCallId: 'read-one',
  kind: 'tool.requested', outcome: 'pending', operation: 'read', mapping: 'exact',
  entityIds: ['z.file'], ...changes,
});

test('the current file and all containing blocks survive the first page of a large project', async t => {
  const f = await fixture(t);
  f.state.entities = [entity('root'), ...Array.from({ length: 2600 }, (_, i) =>
    entity(`a.${String(i).padStart(4, '0')}`, 'root')),
  entity('z.app', 'root'), entity('z.feature', 'z.app'), entity('z.file', 'z.feature'),
  entity('z.method', 'z.file')];
  f.state.interpretations = [];
  f.state.activity = [
    ...Array.from({ length: 500 }, (_, i) => activity(`old-${i}`, i, {
      kind: 'source.parsed', operation: undefined, mapping: undefined, entityIds: [],
    })),
    activity('requested', 501),
    activity('completed', 502, { kind: 'tool.succeeded', outcome: 'succeeded' }),
    activity('mapped', 503, { kind: 'activity.mapped', outcome: 'succeeded', mapping: 'decision',
      entityIds: ['z.file', 'z.method'] }),
  ];
  const original = structuredClone(f.state);
  const first = await f.request('snapshot');
  assert.equal(first.status, 200);
  assert.deepEqual(ids(first.data.entities).slice(0, 5), ['root', 'z.app', 'z.feature', 'z.file', 'z.method']);
  assert.deepEqual(ids(first.data.activity).slice(0, 3), ['mapped', 'completed', 'requested']);
  const hydrated = await hydrateModel(first.data, { request: async url => {
    const response = await f.request(url.replace('/api/model/v1/', ''));
    assert.equal(response.status, 200, response.raw);
    return response.data;
  } });
  assert.equal(hydrated.entities.length, 2048);
  assert.ok(hydrated.entities.some(value => value.id === 'z.method'));
  assert.equal(new Set(ids(hydrated.activity)).size, 503);
  assert.deepEqual(f.state, original);
});

test('activity ordering is scoped, grant-bound, deterministic, and validated in cursors', async t => {
  const f = await fixture(t);
  f.state.activity = [activity('read', 3, { entityIds: ['child'] })];
  const first = await f.request('entities?limit=1');
  assert.deepEqual(ids(first.data.items), ['root']);
  const cursor = cursorQuery(first.data.page.nextCursor);
  f.state.entities.reverse();
  const continued = await f.request(`entities?cursor=${cursor}`);
  assert.equal(continued.status, 200);
  assert.deepEqual(ids(continued.data.items), ['alpha', 'child', 'beta']);
  const scoped = await f.request('snapshot?scope=beta');
  assert.deepEqual(ids(scoped.data.entities), ['root', 'beta']);
  assert.deepEqual(scoped.data.activity, []);
  const otherSession = await f.request('snapshot?session=session-two');
  assert.deepEqual(ids(otherSession.data.entities), ['root', 'alpha', 'beta', 'child']);
  const grant = await f.grant({ fields: ['entities'], history: false });
  const options = { viewer: false, headers: grant.headers };
  const granted = await f.request('entities?limit=1', options);
  f.state.activity[0].entityIds = ['beta'];
  const unchanged = await f.request(`entities?cursor=${cursorQuery(granted.data.page.nextCursor)}`, options);
  assert.equal(unchanged.status, 200, 'withheld activity cannot affect cursor order');
  assert.deepEqual(ids(unchanged.data.items), ['alpha', 'beta', 'child']);
  assert.equal((await f.request(`entities?cursor=${cursor}`)).status, 409);
});

test('activity metadata allowlist preserves operations without exposing arbitrary fields', async t => {
  const f = await fixture(t);
  f.state.activity = [activity('edit', 3, { operation: 'edit', mapping: 'decision',
    entityIds: ['child'], command: 'DO_NOT_DISCLOSE', input: { text: 'DO_NOT_DISCLOSE' },
    path: '/private/DO_NOT_DISCLOSE' })];
  const first = await f.request('snapshot');
  assert.equal(first.data.activity[0].operation, 'edit');
  assert.equal(first.data.activity[0].mapping, 'decision');
  assert.doesNotMatch(first.raw, /DO_NOT_DISCLOSE/);
  f.state.activity[0].operation = 'DO_NOT_DISCLOSE';
  f.state.activity[0].mapping = 'DO_NOT_DISCLOSE';
  const second = await f.request('snapshot');
  assert.equal(second.data.activity[0].operation, undefined);
  assert.equal(second.data.activity[0].mapping, undefined);
});
